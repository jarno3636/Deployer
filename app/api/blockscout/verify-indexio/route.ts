import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { indexioStandardJsonInput } from '../../../../lib/indexio-verification.generated';

export const runtime = 'nodejs';

const CHAIN_ID = 8453;
const COMPILER = 'v0.8.30+commit.73712a01';
const API = 'https://api.blockscout.com/v2/api';

const CONTRACTS = {
  registry: 'contracts/indexio/IndexioAssetRegistry.sol:IndexioAssetRegistry',
  factory: 'contracts/indexio/IndexioFactory.sol:IndexioFactory',
  executionRouter: 'contracts/indexio/IndexioExecutionRouter.sol:IndexioExecutionRouter',
  rebalanceRouter: 'contracts/indexio/IndexioRebalanceRouter.sol:IndexioRebalanceRouter',
} as const;

type ContractKind = keyof typeof CONTRACTS;

async function blockscout(body: URLSearchParams, key: string) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Bearer ${key}`,
    },
    body: body.toString(),
    cache: 'no-store',
  });
  const json = await res.json();
  return { res, json };
}

async function isVerified(address: string, key: string) {
  const params = new URLSearchParams({
    chain_id: String(CHAIN_ID),
    module: 'contract',
    action: 'getsourcecode',
    address,
    apikey: key,
  });
  const { res, json } = await blockscout(params, key);
  if (!res.ok) return false;
  const first = Array.isArray(json?.result) ? json.result[0] : undefined;
  const source = String(first?.SourceCode || first?.sourceCode || '');
  const name = String(first?.ContractName || first?.contractName || '');
  return source.length > 0 || name.length > 0;
}

export async function POST(req: NextRequest) {
  try {
    const key = process.env.BLOCKSCOUT_API_KEY;
    if (!key) return NextResponse.json({ error: 'BLOCKSCOUT_API_KEY is missing in Vercel.' }, { status: 500 });

    const { kind, address, constructorArguments = '', mode = 'verify' } = await req.json();
    if (!(kind in CONTRACTS)) return NextResponse.json({ error: 'Unknown Indexio contract kind.' }, { status: 400 });
    if (!isAddress(address)) return NextResponse.json({ error: 'Valid deployed contract address required.' }, { status: 400 });

    if (await isVerified(address, key)) {
      return NextResponse.json({ ok: true, verified: true, message: 'Contract is verified on Blockscout.' });
    }
    if (mode === 'check') {
      return NextResponse.json({ ok: true, verified: false, message: 'Blockscout has not published the source yet.' });
    }

    const params = new URLSearchParams({
      chain_id: String(CHAIN_ID),
      module: 'contract',
      action: 'verifysourcecode',
      codeformat: 'solidity-standard-json-input',
      contractaddress: address,
      contractname: CONTRACTS[kind as ContractKind],
      compilerversion: COMPILER,
      sourceCode: indexioStandardJsonInput,
      constructorArguments: String(constructorArguments).replace(/^0x/, ''),
      apikey: key,
    });

    const { res, json } = await blockscout(params, key);
    const message = String(json?.result || json?.message || 'Verification submitted.');
    if (!res.ok || (String(json?.status) === '0' && !/already verified/i.test(message))) {
      return NextResponse.json({ error: message || `Blockscout verification failed (${res.status}).` }, { status: 422 });
    }

    // Give Blockscout a short indexing window. If it is still processing, the UI
    // exposes a read-only "Check verification" action; no transaction is resent.
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (await isVerified(address, key)) {
        return NextResponse.json({ ok: true, verified: true, message: 'Contract verified and source published on Blockscout.' });
      }
    }

    return NextResponse.json({ ok: true, verified: false, message: `${message} Blockscout is still indexing; use Check verification.` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Indexio verification failed.' }, { status: 500 });
  }
}
