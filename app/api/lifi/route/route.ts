import { NextRequest, NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';

const BASE_CHAIN_ID = '8453';
const BASE_USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const DEFAULT_SAMPLE_USDC = '25000000';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Self-service quote discovery for any Base ERC20 pair, including B20 assets.
 * This is a quote/compatibility endpoint, NOT an authorization to execute
 * arbitrary LI.FI calldata. Execution remains gated by adapter checks.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.fromAddress !== 'string' || !isAddress(body.fromAddress)) {
      return NextResponse.json({ error: 'Valid fromAddress required.' }, { status: 400 });
    }
    const fromAddress = getAddress(body.fromAddress);
    const explicitPair = typeof body.fromToken === 'string' && isAddress(body.fromToken) && typeof body.toToken === 'string' && isAddress(body.toToken);
    const legacyToken = typeof body.toToken === 'string' && isAddress(body.toToken) ? getAddress(body.toToken) : null;
    if (!explicitPair && !legacyToken) return NextResponse.json({ error: 'Valid fromToken and toToken required.' }, { status: 400 });
    const direction = body.direction === 'sell' ? 'sell' : 'buy';
    const fromToken = explicitPair ? getAddress(body.fromToken as string) : direction === 'sell' ? legacyToken! : BASE_USDC;
    const toToken = explicitPair ? getAddress(body.toToken as string) : direction === 'sell' ? BASE_USDC : legacyToken!;
    if (fromToken.toLowerCase() === toToken.toLowerCase()) return NextResponse.json({ error: 'Tokens must differ.' }, { status: 400 });
    const decimals = typeof body.tokenDecimals === 'number' && Number.isInteger(body.tokenDecimals) && body.tokenDecimals >= 0 && body.tokenDecimals <= 36 ? body.tokenDecimals : 18;
    const fallbackAmount = fromToken.toLowerCase() === BASE_USDC.toLowerCase() ? DEFAULT_SAMPLE_USDC : (10n ** BigInt(decimals)).toString();
    const fromAmount = typeof body.fromAmount === 'string' && /^\d{1,78}$/.test(body.fromAmount) && BigInt(body.fromAmount) > 0n ? body.fromAmount : fallbackAmount;
    const slippageBps = typeof body.slippageBps === 'number' && Number.isInteger(body.slippageBps) && body.slippageBps >= 10 && body.slippageBps <= 3000 ? body.slippageBps : 50;
    const q = new URLSearchParams({
      fromChain: BASE_CHAIN_ID, toChain: BASE_CHAIN_ID,
      fromToken, toToken, fromAddress, toAddress: fromAddress,
      fromAmount, slippage: (slippageBps / 10000).toString(),
      maxPriceImpact: '0.05', denyBridges: 'all',
      // Never skip simulation: fee-on-transfer tokens require extra caution.
      skipSimulation: 'false', integrator: 'indexio',
    });
    const headers: Record<string,string> = { accept: 'application/json' };
    if (process.env.LIFI_API_KEY) headers['x-lifi-api-key'] = process.env.LIFI_API_KEY;
    const upstream = await fetch(`https://li.quest/v1/quote?${q}`, { headers, cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const data = await upstream.json().catch(() => null) as any;
    if (!upstream.ok) {
      const message = data?.message || data?.error?.message || data?.error || `LI.FI HTTP ${upstream.status}`;
      return NextResponse.json({ error: String(message), fromToken, toToken, direction, upstreamStatus: upstream.status }, { status: upstream.status === 429 ? 429 : 502 });
    }
    const target = data?.transactionRequest?.to;
    const spender = data?.estimate?.approvalAddress;
    const callData = data?.transactionRequest?.data;
    if (!isAddress(target) || !isAddress(spender) || typeof callData !== 'string' || !/^0x[0-9a-fA-F]{8,}$/.test(callData)) {
      return NextResponse.json({ error: 'LI.FI returned an incomplete executable quote.' }, { status: 502 });
    }
    const estimatedMin = data?.estimate?.toAmountMin;
    return NextResponse.json({
      target: getAddress(target), spender: getAddress(spender), selector: callData.slice(0,10),
      tool: data?.toolDetails?.name || data?.tool || 'LI.FI',
      fromAmount: data?.estimate?.fromAmount || fromAmount,
      toAmount: data?.estimate?.toAmount || '', toAmountMin: estimatedMin || '',
      fromToken, toToken, direction, sampledToken: toToken, sampledChain: 8453,
      slippageBps, permissionDiscoveryOnly: true, executableByIndexio: false,
      warning: 'Discovery is not execution approval. Taxed tokens may incur multiple variable fees; onchain minimum net output and adapter permissions must still pass.',
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Quote discovery failed.' }, { status: 500 });
  }
}
