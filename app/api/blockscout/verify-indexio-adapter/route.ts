import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { indexioAdapterStandardJsonInput } from '../../../../lib/indexio-adapter-verification.generated';

export const runtime = 'nodejs';

const CHAIN_ID = 8453;
const COMPILER = 'v0.8.30+commit.73712a01';
const UNIFIED_API = 'https://api.blockscout.com/v2/api';
const BASE_API = 'https://base.blockscout.com/api';
const BASE_V2 = 'https://base.blockscout.com/api/v2';
const CONTRACT_NAME = 'contracts/indexio/IndexioRestrictedSwapAdapter.sol:IndexioRestrictedSwapAdapter';

async function readJson(res: Response) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { message: text || `HTTP ${res.status}` }; }
}

async function isVerified(address: string, key: string) {
  try {
    const res = await fetch(`${BASE_V2}/smart-contracts/${address}`, {
      headers: key ? { authorization: `Bearer ${key}` } : undefined,
      cache: 'no-store',
    });
    if (res.ok) {
      const json = await readJson(res);
      if (json?.is_verified === true || json?.isVerified === true) return true;
      if (String(json?.source_code || json?.sourceCode || '').length > 0) return true;
    }
  } catch {}

  const q = new URLSearchParams({ module: 'contract', action: 'getsourcecode', address, apikey: key });
  const res = await fetch(`${BASE_API}?${q}`, { cache: 'no-store' });
  if (!res.ok) return false;
  const json = await readJson(res);
  const first = Array.isArray(json?.result) ? json.result[0] : undefined;
  return String(first?.SourceCode || '').length > 0 || String(first?.ContractName || '').length > 0;
}

async function submit(params: URLSearchParams, key: string) {
  const endpoints = [
    { url: UNIFIED_API, unified: true },
    { url: BASE_API, unified: false },
  ];
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    const body = new URLSearchParams(params);
    if (endpoint.unified) body.set('chain_id', String(CHAIN_ID)); else body.delete('chain_id');
    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: body.toString(),
        cache: 'no-store',
      });
      const json = await readJson(res);
      const message = String(json?.result || json?.message || `HTTP ${res.status}`);
      const status = String(json?.status ?? '');
      if (res.ok && (status !== '0' || /already verified|already been verified/i.test(message))) return { ok: true, message };
      errors.push(message);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : 'request failed');
    }
  }
  return { ok: false, message: errors.join(' | ') || 'Verification submission failed.' };
}

export async function POST(req: NextRequest) {
  try {
    const key = process.env.BLOCKSCOUT_API_KEY || '';
    const { address, constructorArguments = '', mode = 'verify' } = await req.json();
    if (!isAddress(address)) return NextResponse.json({ error: 'Valid Base adapter address required.' }, { status: 400 });

    if (await isVerified(address, key)) return NextResponse.json({ ok: true, verified: true, message: 'Verified on Base Blockscout.' });
    if (mode === 'check') return NextResponse.json({ ok: true, verified: false, message: 'Source is not published yet.' });

    const params = new URLSearchParams({
      chain_id: String(CHAIN_ID),
      module: 'contract',
      action: 'verifysourcecode',
      codeformat: 'solidity-standard-json-input',
      contractaddress: address,
      contractname: CONTRACT_NAME,
      compilerversion: COMPILER,
      sourceCode: indexioAdapterStandardJsonInput,
      constructorArguments: String(constructorArguments).replace(/^0x/, ''),
      apikey: key,
    });

    const submitted = await submit(params, key);
    if (!submitted.ok) return NextResponse.json({ error: submitted.message, deployed: true, verified: false }, { status: 422 });

    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      if (await isVerified(address, key)) return NextResponse.json({ ok: true, verified: true, message: 'Verified and published.' });
    }
    return NextResponse.json({ ok: true, verified: false, message: 'Verification accepted; publication is still pending.' });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Adapter verification failed.' }, { status: 500 });
  }
}
