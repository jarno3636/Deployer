import { NextResponse } from 'next/server';
import {
  etherscanCompilerVersion,
  etherscanContractNames,
  launchStandardJsonInput,
} from '../../../lib/launch.verification.generated';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const BASE_CHAIN_ID = '8453';

const allowedContracts = new Set(Object.keys(etherscanContractNames));

function apiKey() {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error('ETHERSCAN_API_KEY is not configured in Vercel.');
  return key;
}

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

async function submitVerification(
  contractAddress: string,
  contractKey: string,
  constructorArguments: string,
) {
  const contractName = etherscanContractNames[
    contractKey as keyof typeof etherscanContractNames
  ];

  const url = new URL(ETHERSCAN_V2);
  url.searchParams.set('apikey', apiKey());
  url.searchParams.set('chainid', BASE_CHAIN_ID);
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'verifysourcecode');

  const body = new URLSearchParams({
    contractaddress: contractAddress,
    sourceCode: launchStandardJsonInput,
    contractname: contractName,
    compilerversion: etherscanCompilerVersion,
    codeformat: 'solidity-standard-json-input',
    optimizationUsed: '1',
    runs: '200',
    constructorArguments,
    licenseType: '3',
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });

  return (await response.json()) as {
    status: string;
    message: string;
    result: string;
  };
}

async function checkVerification(guid: string) {
  const url = new URL(ETHERSCAN_V2);
  url.searchParams.set('apikey', apiKey());
  url.searchParams.set('chainid', BASE_CHAIN_ID);
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'checkverifystatus');
  url.searchParams.set('guid', guid);

  const response = await fetch(url, { cache: 'no-store' });
  return (await response.json()) as {
    status: string;
    message: string;
    result: string;
  };
}

export async function POST(request: Request) {
  try {
    const payload = await request.json();

    if (payload?.action === 'status') {
      if (typeof payload.guid !== 'string' || !payload.guid) {
        return NextResponse.json(
          { ok: false, error: 'Missing verification GUID.' },
          { status: 400 },
        );
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
      return NextResponse.json(
        { ok: false, error: 'Invalid contract address.' },
        { status: 400 },
      );
    }

    if (
      typeof payload?.contractKey !== 'string' ||
      !allowedContracts.has(payload.contractKey)
    ) {
      return NextResponse.json(
        { ok: false, error: 'Invalid contract key.' },
        { status: 400 },
      );
    }

    const constructorArguments =
      typeof payload?.constructorArguments === 'string'
        ? payload.constructorArguments.replace(/^0x/, '')
        : '';

    if (!/^[a-fA-F0-9]*$/.test(constructorArguments)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid constructor arguments.' },
        { status: 400 },
      );
    }

    const data = await submitVerification(
      payload.contractAddress,
      payload.contractKey,
      constructorArguments,
    );
    const result = String(data.result ?? '');

    if (data.status !== '1') {
      if (/already verified/i.test(result)) {
        return NextResponse.json({ ok: true, verified: true, result });
      }

      return NextResponse.json(
        {
          ok: false,
          error: result || data.message || 'Verification submission failed.',
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, verified: false, guid: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Verification failed.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
