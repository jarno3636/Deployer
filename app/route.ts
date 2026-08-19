import { NextResponse } from 'next/server';
import {
  etherscanCompilerVersion,
  etherscanContractName,
  marketplaceStandardJsonInput,
} from '../../../lib/marketplace.verification.generated';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const BASE_CHAIN_ID = '8453';

function apiKey() {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error('ETHERSCAN_API_KEY is not configured in Vercel.');
  return key;
}

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

async function submitVerification(contractAddress: string) {
  const url = new URL(ETHERSCAN_V2);
  url.searchParams.set('apikey', apiKey());
  url.searchParams.set('chainid', BASE_CHAIN_ID);
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'verifysourcecode');

  const body = new URLSearchParams({
    contractaddress: contractAddress,
    sourceCode: marketplaceStandardJsonInput,
    contractname: etherscanContractName,
    compilerversion: etherscanCompilerVersion,
    codeformat: 'solidity-standard-json-input',
    optimizationUsed: '1',
    runs: '200',
    constructorArguments: '',
    licenseType: '3',
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });

  const data = await response.json();
  return data as { status: string; message: string; result: string };
}

async function checkVerification(guid: string) {
  const url = new URL(ETHERSCAN_V2);
  url.searchParams.set('apikey', apiKey());
  url.searchParams.set('chainid', BASE_CHAIN_ID);
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'checkverifystatus');
  url.searchParams.set('guid', guid);

  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json();
  return data as { status: string; message: string; result: string };
}

export async function POST(request: Request) {
  try {
    const payload = await request.json();

    if (payload?.action === 'status') {
      if (typeof payload.guid !== 'string' || !payload.guid) {
        return NextResponse.json({ ok: false, error: 'Missing verification GUID.' }, { status: 400 });
      }

      const data = await checkVerification(payload.guid);
      const result = String(data.result ?? '');
      const verified = data.status === '1' && /pass\s*-\s*verified/i.test(result);
      const pending = /pending|queue|in progress/i.test(result);

      return NextResponse.json({
        ok: verified || pending,
        verified,
        pending,
        result,
      });
    }

    if (!isAddress(payload?.contractAddress)) {
      return NextResponse.json({ ok: false, error: 'Invalid contract address.' }, { status: 400 });
    }

    const data = await submitVerification(payload.contractAddress);
    const result = String(data.result ?? '');

    if (data.status !== '1') {
      const alreadyVerified = /already verified/i.test(result);
      if (alreadyVerified) {
        return NextResponse.json({ ok: true, verified: true, result });
      }

      return NextResponse.json(
        { ok: false, error: result || data.message || 'Verification submission failed.' },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, verified: false, guid: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Verification failed.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
