import { NextRequest, NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';

const BASE_CHAIN_ID = '8453';
const BASE_USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const SAMPLE_AMOUNT = '10000000'; // 10 USDC, six decimals. Quote discovery only.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as { toToken?: string; fromAddress?: string } | null;
    if (!body || !body.toToken || !body.fromAddress || !isAddress(body.toToken) || !isAddress(body.fromAddress)) {
      return NextResponse.json({ error: 'Valid toToken and fromAddress are required.' }, { status: 400 });
    }

    const toToken = getAddress(body.toToken);
    const fromAddress = getAddress(body.fromAddress);
    if (toToken.toLowerCase() === BASE_USDC.toLowerCase()) {
      return NextResponse.json({ error: 'Choose a registered non-USDC constituent token.' }, { status: 400 });
    }

    const q = new URLSearchParams({
      fromChain: BASE_CHAIN_ID,
      toChain: BASE_CHAIN_ID,
      fromToken: BASE_USDC,
      toToken,
      fromAddress,
      toAddress: fromAddress,
      fromAmount: SAMPLE_AMOUNT,
      slippage: '0.005',
      maxPriceImpact: '0.05',
      denyBridges: 'all',
      skipSimulation: 'true',
      integrator: 'indexio',
    });

    const headers: Record<string,string> = { accept: 'application/json' };
    if (process.env.LIFI_API_KEY) headers['x-lifi-api-key'] = process.env.LIFI_API_KEY;

    const upstream = await fetch(`https://li.quest/v1/quote?${q.toString()}`, {
      method: 'GET', headers, cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    const data = await upstream.json().catch(() => null) as any;
    if (!upstream.ok) {
      const message = data?.message || data?.error?.message || data?.error || `LI.FI returned HTTP ${upstream.status}.`;
      return NextResponse.json({ error: String(message) }, { status: upstream.status === 429 ? 429 : 502 });
    }

    const target = data?.transactionRequest?.to;
    const spender = data?.estimate?.approvalAddress;
    const callData = data?.transactionRequest?.data;
    if (!isAddress(target) || !isAddress(spender) || typeof callData !== 'string' || !/^0x[0-9a-fA-F]{8,}$/.test(callData)) {
      return NextResponse.json({ error: 'LI.FI returned a quote without a usable target, approvalAddress, or calldata selector.' }, { status: 502 });
    }

    return NextResponse.json({
      target: getAddress(target),
      spender: getAddress(spender),
      selector: callData.slice(0, 10),
      tool: data?.toolDetails?.name || data?.tool || 'LI.FI',
      fromAmount: data?.estimate?.fromAmount || SAMPLE_AMOUNT,
      toAmountMin: data?.estimate?.toAmountMin || '',
      sampledToken: toToken,
      sampledChain: Number(BASE_CHAIN_ID),
      slippage: 0.005,
      permissionDiscoveryOnly: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'LI.FI route lookup failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
