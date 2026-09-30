import { NextRequest, NextResponse } from 'next/server';
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
} from 'viem';
import { base } from 'viem/chains';

const BASE_CHAIN_ID = '8453';
const BASE_USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const ASSET_REGISTRY = getAddress('0x5C4791e3B752d9b084E8FD76932E82C2031f15c1');
const LIFI_DEPLOYMENTS = 'https://raw.githubusercontent.com/lifinance/contracts/main/deployments/base.json';
const LIFI_WHITELIST = 'https://raw.githubusercontent.com/lifinance/contracts/main/config/whitelist.json';
const BLOCKSCOUT_LOGS = 'https://base.blockscout.com/api';
const MAX_ASSETS = 60;

const registryAbi = parseAbi([
  'event AssetConfigured(address indexed asset,bool enabled,uint16 maxWeightBps,uint8 decimals)',
  'event AssetDisabled(address indexed asset)',
  'function config(address asset) view returns (bool enabled,uint16 maxWeightBps,uint8 decimals)',
]);

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org'),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type RouteHit = {
  target: Address;
  spender: Address;
  selector: `0x${string}`;
  tool: string;
  asset: Address;
  direction: 'buy' | 'sell';
};

function topic(sig: string) {
  return keccak256(stringToHex(sig));
}

async function blockscoutLogs(topic0: `0x${string}`) {
  const q = new URLSearchParams({
    module: 'logs',
    action: 'getLogs',
    address: ASSET_REGISTRY,
    fromBlock: '0',
    toBlock: 'latest',
    topic0,
    page: '1',
    offset: '1000',
  });
  const r = await fetch(`${BLOCKSCOUT_LOGS}?${q.toString()}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null) as any;
  if (!r.ok || !j || (j.status !== '1' && !Array.isArray(j.result))) {
    throw new Error(j?.message || 'Blockscout could not enumerate Asset Registry events.');
  }
  return Array.isArray(j.result) ? j.result : [];
}

async function discoverEnabledAssets() {
  const configuredTopic = topic('AssetConfigured(address,bool,uint16,uint8)');
  const disabledTopic = topic('AssetDisabled(address)');
  const [configured, disabled] = await Promise.all([
    blockscoutLogs(configuredTopic),
    blockscoutLogs(disabledTopic),
  ]);

  const seen = new Set<string>();
  for (const log of [...configured, ...disabled]) {
    const indexed = Array.isArray(log?.topics) ? log.topics[1] : null;
    if (typeof indexed === 'string' && /^0x[0-9a-fA-F]{64}$/.test(indexed)) {
      seen.add(getAddress(`0x${indexed.slice(-40)}`).toLowerCase());
    }
  }
  const assets = [...seen].slice(0, MAX_ASSETS).map((x) => getAddress(x));
  if (!assets.length) throw new Error('No Asset Registry events were found on Base.');

  const configs = await Promise.all(assets.map(async (asset) => {
    try {
      const cfg = await publicClient.readContract({ address: ASSET_REGISTRY, abi: registryAbi, functionName: 'config', args: [asset] }) as readonly [boolean, number, number];
      return { asset, enabled: Boolean(cfg[0]), decimals: Number(cfg[2]) };
    } catch {
      return { asset, enabled: false, decimals: 18 };
    }
  }));
  return configs.filter((x) => x.enabled && x.asset.toLowerCase() !== BASE_USDC.toLowerCase());
}

async function trustedLifiAddresses() {
  const [depRes, whiteRes] = await Promise.all([
    fetch(LIFI_DEPLOYMENTS, { cache: 'no-store', signal: AbortSignal.timeout(12000) }),
    fetch(LIFI_WHITELIST, { cache: 'no-store', signal: AbortSignal.timeout(12000) }),
  ]);
  if (!depRes.ok || !whiteRes.ok) throw new Error('Could not load LI.FI official Base contract metadata.');
  const deployments = await depRes.json() as Record<string, string>;
  const whitelist = await whiteRes.json() as any;
  const deploymentSet = new Set<string>();
  for (const value of Object.values(deployments)) if (isAddress(value)) deploymentSet.add(getAddress(value).toLowerCase());
  const whitelistSet = new Set<string>();
  const whitelistSelectors = new Map<string, Set<string>>();
  for (const dex of Array.isArray(whitelist?.DEXS) ? whitelist.DEXS : []) {
    for (const entry of Array.isArray(dex?.contracts?.base) ? dex.contracts.base : []) {
      if (isAddress(entry?.address)) {
        const addr = getAddress(entry.address).toLowerCase();
        whitelistSet.add(addr);
        const selectors = new Set<string>(Object.keys(entry?.functions || {}).map((x) => x.toLowerCase()));
        whitelistSelectors.set(addr, selectors);
      }
    }
  }
  return { deploymentSet, whitelistSet, whitelistSelectors };
}

async function quote(fromToken: Address, toToken: Address, fromAmount: string, fromAddress: Address): Promise<RouteHit> {
  const q = new URLSearchParams({
    fromChain: BASE_CHAIN_ID,
    toChain: BASE_CHAIN_ID,
    fromToken,
    toToken,
    fromAddress,
    toAddress: fromAddress,
    fromAmount,
    slippage: '0.005',
    maxPriceImpact: '0.05',
    denyBridges: 'all',
    skipSimulation: 'true',
    integrator: 'indexio',
  });
  const headers: Record<string, string> = { accept: 'application/json' };
  if (process.env.LIFI_API_KEY) headers['x-lifi-api-key'] = process.env.LIFI_API_KEY;
  const r = await fetch(`https://li.quest/v1/quote?${q.toString()}`, { headers, cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const data = await r.json().catch(() => null) as any;
  if (!r.ok) throw new Error(data?.message || data?.error?.message || `LI.FI ${r.status}`);
  const target = data?.transactionRequest?.to;
  const spender = data?.estimate?.approvalAddress;
  const callData = data?.transactionRequest?.data;
  if (!isAddress(target) || !isAddress(spender) || typeof callData !== 'string' || !/^0x[0-9a-fA-F]{8,}$/.test(callData)) {
    throw new Error('LI.FI quote did not contain a usable route tuple.');
  }
  return {
    target: getAddress(target),
    spender: getAddress(spender),
    selector: callData.slice(0, 10) as `0x${string}`,
    tool: String(data?.toolDetails?.name || data?.tool || 'LI.FI'),
    asset: getAddress(toToken.toLowerCase() === BASE_USDC.toLowerCase() ? fromToken : toToken),
    direction: fromToken.toLowerCase() === BASE_USDC.toLowerCase() ? 'buy' : 'sell',
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as { fromAddress?: string } | null;
    if (!body?.fromAddress || !isAddress(body.fromAddress)) return NextResponse.json({ error: 'A valid deployment wallet address is required.' }, { status: 400 });
    const fromAddress = getAddress(body.fromAddress);

    const [{ deploymentSet, whitelistSet, whitelistSelectors }, assets] = await Promise.all([
      trustedLifiAddresses(),
      discoverEnabledAssets(),
    ]);

    const hits: RouteHit[] = [];
    let failures = 0;
    let assetsQuoted = 0;

    // Keep concurrency modest so the public LI.FI API and Base RPC are not hammered.
    for (let i = 0; i < assets.length; i += 4) {
      const batch = assets.slice(i, i + 4);
      const results = await Promise.all(batch.map(async ({ asset, decimals }) => {
        let ok = false;
        const local: RouteHit[] = [];
        try { local.push(await quote(BASE_USDC, asset, '10000000', fromAddress)); ok = true; } catch { failures++; }
        try {
          const whole = 10n ** BigInt(Math.min(Math.max(decimals, 0), 24));
          local.push(await quote(asset, BASE_USDC, whole.toString(), fromAddress)); ok = true;
        } catch { failures++; }
        return { ok, local };
      }));
      for (const r of results) {
        if (r.ok) assetsQuoted++;
        hits.push(...r.local);
      }
    }

    const trusted: RouteHit[] = [];
    for (const hit of hits) {
      const target = hit.target.toLowerCase();
      const spender = hit.spender.toLowerCase();
      // Accept only contracts published by LI.FI for Base: either an official LI.FI deployment
      // or a Base DEX target in LI.FI's own whitelist. For direct DEX targets, also require that
      // LI.FI explicitly whitelists the returned function selector for that target.
      const targetIsDeployment = deploymentSet.has(target);
      const targetIsWhitelistedDex = whitelistSet.has(target);
      if (!(targetIsDeployment || targetIsWhitelistedDex)) continue;
      if (targetIsWhitelistedDex && !targetIsDeployment) {
        const selectors = whitelistSelectors.get(target);
        if (selectors && selectors.size > 0 && !selectors.has(hit.selector.toLowerCase())) continue;
      }
      const canonicalPermit2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
      if (!(deploymentSet.has(spender) || whitelistSet.has(spender) || spender === target || spender === canonicalPermit2)) continue;
      const [targetCode, spenderCode] = await Promise.all([
        publicClient.getBytecode({ address: hit.target }),
        publicClient.getBytecode({ address: hit.spender }),
      ]);
      if (!targetCode || targetCode === '0x' || !spenderCode || spenderCode === '0x') continue;
      trusted.push(hit);
    }

    const grouped = new Map<string, { target: Address; spender: Address; selector: `0x${string}`; tool: string; coverage: number; samples: string[] }>();
    for (const hit of trusted) {
      const key = `${hit.target.toLowerCase()}:${hit.spender.toLowerCase()}:${hit.selector.toLowerCase()}`;
      const sample = `${hit.direction}:${hit.asset}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.coverage++;
        if (existing.samples.length < 6 && !existing.samples.includes(sample)) existing.samples.push(sample);
      } else {
        grouped.set(key, { target: hit.target, spender: hit.spender, selector: hit.selector, tool: hit.tool, coverage: 1, samples: [sample] });
      }
    }

    const routes = [...grouped.values()].sort((a, b) => b.coverage - a.coverage);
    if (!routes.length) {
      return NextResponse.json({
        error: 'Live LI.FI quotes were found, but none matched the current official LI.FI Base deployment/allowlist trust checks. Do not finalize bootstrap.',
        assetsFound: assets.length,
        assetsQuoted,
        failures,
      }, { status: 409 });
    }

    return NextResponse.json({
      routes,
      assetsFound: assets.length,
      assetsQuoted,
      failures,
      trustSource: 'LI.FI official deployments/base.json + config/whitelist.json',
      quoteDirections: ['USDC→asset', 'asset→USDC'],
      quoteSlippage: 0.005,
      permissionDiscoveryOnly: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'LI.FI route discovery failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
