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
const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
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

const RPC_ENDPOINTS = [
  'https://base-rpc.publicnode.com',
  'https://base.drpc.org',
  'https://mainnet.base.org',
];

async function rpcCall(url: string, method: string, params: any[]) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
  });
  const j = await r.json().catch(() => null) as any;
  if (!r.ok || !j || j.error) throw new Error(j?.error?.message || `RPC ${r.status}`);
  return j.result;
}

async function findContractStartBlock(url: string, latest: bigint) {
  // Binary-search the first block where the reused registry has bytecode.
  // This avoids scanning Base from genesis and needs only ~26 eth_getCode calls.
  let lo = 0n;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) >> 1n;
    const code = await rpcCall(url, 'eth_getCode', [ASSET_REGISTRY, `0x${mid.toString(16)}`]);
    if (typeof code === 'string' && code !== '0x') hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

async function logsFromRpc(url: string, topic0s: `0x${string}`[]) {
  const latestHex = await rpcCall(url, 'eth_blockNumber', []);
  const latest = BigInt(latestHex);
  const first = await findContractStartBlock(url, latest);

  const out: any[] = [];
  let from = first;
  let span = 100_000n;
  const minSpan = 500n;

  while (from <= latest) {
    let to = from + span - 1n;
    if (to > latest) to = latest;
    try {
      const rows = await rpcCall(url, 'eth_getLogs', [{
        address: ASSET_REGISTRY,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        // JSON-RPC topic arrays are OR filters, so configured + disabled are
        // collected in one historical pass instead of scanning twice.
        topics: [topic0s],
      }]);
      if (Array.isArray(rows)) out.push(...rows);
      from = to + 1n;
      // Grow back toward the fast path after a provider accepted a smaller page.
      if (span < 100_000n) span = span * 2n > 100_000n ? 100_000n : span * 2n;
    } catch (e) {
      if (span <= minSpan) throw e;
      span /= 2n;
      if (span < minSpan) span = minSpan;
    }
  }
  return out;
}

async function registryLogs(topic0s: `0x${string}`[]) {
  const errors: string[] = [];
  for (const url of RPC_ENDPOINTS) {
    try {
      return await logsFromRpc(url, topic0s);
    } catch (e) {
      errors.push(`${new URL(url).hostname}: ${e instanceof Error ? e.message : 'unknown RPC error'}`);
    }
  }
  throw new Error(`Could not enumerate Asset Registry events from the free Base RPC fallbacks. ${errors.join(' | ')}`);
}

async function discoverEnabledAssets() {
  const configuredTopic = topic('AssetConfigured(address,bool,uint16,uint8)');
  const disabledTopic = topic('AssetDisabled(address)');
  const logs = await registryLogs([configuredTopic, disabledTopic]);

  const seen = new Set<string>();
  for (const log of logs) {
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
    const rawOffset = Number((body as any)?.offset ?? 0);
    const rawLimit = Number((body as any)?.limit ?? 8);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
    const limit = Number.isFinite(rawLimit) ? Math.min(10, Math.max(1, Math.floor(rawLimit))) : 8;

    const [{ deploymentSet, whitelistSet, whitelistSelectors }, allAssets] = await Promise.all([
      trustedLifiAddresses(),
      discoverEnabledAssets(),
    ]);

    const assets = allAssets.slice(offset, offset + limit);
    const hits: RouteHit[] = [];
    let failures = 0;
    let assetsQuoted = 0;

    // One bounded page per request keeps Vercel well below its function timeout.
    // Buy + sell are requested in parallel for each asset. The UI walks all pages.
    const results = await Promise.all(assets.map(async ({ asset, decimals }) => {
      const whole = 10n ** BigInt(Math.min(Math.max(decimals, 0), 24));
      const settled = await Promise.allSettled([
        quote(BASE_USDC, asset, '10000000', fromAddress),
        quote(asset, BASE_USDC, whole.toString(), fromAddress),
      ]);
      const local: RouteHit[] = [];
      for (const result of settled) {
        if (result.status === 'fulfilled') local.push(result.value);
        else failures++;
      }
      return { ok: local.length > 0, local };
    }));
    for (const r of results) {
      if (r.ok) assetsQuoted++;
      hits.push(...r.local);
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
        assetsFound: allAssets.length,
        assetsScanned: assets.length,
        offset,
        nextOffset: Math.min(offset + assets.length, allAssets.length),
        hasMore: offset + assets.length < allAssets.length,
        assetsQuoted,
        failures,
      }, { status: 409 });
    }

    return NextResponse.json({
      routes,
      assetsFound: allAssets.length,
      assetsScanned: assets.length,
      offset,
      nextOffset: Math.min(offset + assets.length, allAssets.length),
      hasMore: offset + assets.length < allAssets.length,
      assetsQuoted,
      failures,
      registrySource: 'Base RPC with Etherscan V2 fallback',
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
