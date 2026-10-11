import { NextRequest, NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Read-only, trade-specific discovery for the independently deployed buy adapter.
// Never infer these permissions from the router address, an old adapter or a generic selector.
const CHAIN = '8453';
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const ROUTER = getAddress('0xB5e9906764D7fc51aA6481d5a00a5197702c336F');
const ADAPTER = getAddress('0xaB3d69F2B5D138CB01E95D70239571F45Fcd9a24');
const OFFICIAL_DEPLOYMENTS = 'https://raw.githubusercontent.com/lifinance/contracts/main/deployments/base.json';
const OFFICIAL_WHITELIST = 'https://raw.githubusercontent.com/lifinance/contracts/main/config/whitelist.json';
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

const fail = (message: string, status = 422) => NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const token = typeof body?.asset === 'string' && isAddress(body.asset) ? getAddress(body.asset) : null;
    if (!token || token.toLowerCase() === USDC.toLowerCase()) return fail('Select the exact Base token or B20 stock contract address.', 400);
    // This is deliberately fixed to a small example purchase, not an executable trade.
    const fromAmount = '10000000'; // 10 USDC, six decimals
    const q = new URLSearchParams({
      fromChain: CHAIN, toChain: CHAIN, fromToken: USDC, toToken: token,
      fromAmount, fromAddress: ADAPTER, toAddress: ROUTER,
      slippage: '0.005', maxPriceImpact: '0.08', denyBridges: 'all',
      skipSimulation: 'true', integrator: 'indexio',
    });
    const headers: Record<string, string> = { accept: 'application/json' };
    if (process.env.LIFI_API_KEY) headers['x-lifi-api-key'] = process.env.LIFI_API_KEY;
    const upstream = await fetch(`https://li.quest/v1/quote?${q.toString()}`, {
      headers, cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    const quote = await upstream.json().catch(() => null) as any;
    if (!upstream.ok) return fail(`LI.FI has no example route for this asset: ${String(quote?.message || quote?.error?.message || `HTTP ${upstream.status}`).slice(0, 240)}`);
    const targetRaw = quote?.transactionRequest?.to;
    const spenderRaw = quote?.estimate?.approvalAddress;
    const calldata = quote?.transactionRequest?.data;
    const inputAmount = String(quote?.estimate?.fromAmount || quote?.action?.fromAmount || '');
    const outputAmount = String(quote?.estimate?.toAmount || '');
    if (!isAddress(targetRaw) || !isAddress(spenderRaw) || typeof calldata !== 'string' ||
      !/^0x[0-9a-fA-F]{8,}$/.test(calldata) || inputAmount !== fromAmount ||
      !/^\d+$/.test(outputAmount) || BigInt(outputAmount) <= 0n ||
      BigInt(String(quote?.transactionRequest?.value || '0')) !== 0n) {
      return fail('LI.FI did not return a consistent token-only swap quote. No permissions were suggested.');
    }
    const target = getAddress(targetRaw), spender = getAddress(spenderRaw);
    const selector = calldata.slice(0, 10).toLowerCase();
    const [deployRes, allowRes] = await Promise.all([
      fetch(OFFICIAL_DEPLOYMENTS, { cache: 'no-store', signal: AbortSignal.timeout(12000) }),
      fetch(OFFICIAL_WHITELIST, { cache: 'no-store', signal: AbortSignal.timeout(12000) }),
    ]);
    if (!deployRes.ok || !allowRes.ok) return fail('Could not confirm this route against the official LI.FI Base deployments and DEX allowlist. Try again later.', 502);
    const deployed = await deployRes.json() as Record<string, unknown>;
    const whitelist = await allowRes.json() as any;
    const officialAddresses = new Set<string>();
    for (const val of Object.values(deployed)) if (typeof val === 'string' && isAddress(val)) officialAddresses.add(val.toLowerCase());
    const whitelistedDex = new Map<string, Set<string>>();
    for (const dex of Array.isArray(whitelist?.DEXS) ? whitelist.DEXS : []) {
      for (const contract of Array.isArray(dex?.contracts?.base) ? dex.contracts.base : []) {
        if (!isAddress(contract?.address)) continue;
        whitelistedDex.set(String(contract.address).toLowerCase(), new Set(Object.keys(contract?.functions || {}).map(x => x.toLowerCase())));
      }
    }
    const targetLower = target.toLowerCase(), spenderLower = spender.toLowerCase();
    const approvedTargetType = officialAddresses.has(targetLower) || whitelistedDex.has(targetLower);
    const approvedSpenderType = officialAddresses.has(spenderLower) || whitelistedDex.has(spenderLower) ||
      spenderLower === targetLower || spenderLower === PERMIT2;
    const restrictedSelectors = whitelistedDex.get(targetLower);
    const approvedSelectorType = officialAddresses.has(targetLower) || !restrictedSelectors?.size || restrictedSelectors.has(selector);
    if (!approvedTargetType || !approvedSpenderType || !approvedSelectorType) {
      return fail('This quote uses infrastructure outside the reviewed LI.FI Base deployment or DEX allowlist. Do not authorize its target, spender, or selector.');
    }
    // Returning suggestions does NOT mean the route has been executed, audited,
    // simulated successfully, or added to the on-chain adapter allowlist.
    return NextResponse.json({
      target, spender, selector,
      asset: token, sampleUsdc: '10.00', tool: String(quote?.toolDetails?.name || quote?.tool || 'LI.FI').slice(0, 80),
      fromAddress: ADAPTER, toAddress: ROUTER, chainId: 8453,
      source: 'LI.FI live quote + official Base deployment and DEX metadata',
      warning: 'Read-only route discovery. Review all permissions before owner transactions. A successful live swap and vault deposit have not been verified.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return fail(err instanceof Error ? `Unable to discover LI.FI permissions: ${err.message.slice(0, 200)}` : 'LI.FI permission discovery failed.', 502);
  }
}
