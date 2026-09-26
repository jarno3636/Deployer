import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { indexioStandardJsonInput } from '../../../../lib/indexio-verification.generated';

export const runtime = 'nodejs';

const CHAIN_ID = 8453;
const COMPILER = 'v0.8.30+commit.73712a01';
const UNIFIED_API = 'https://api.blockscout.com/v2/api';
const BASE_API = 'https://base.blockscout.com/api';
const BASE_V2 = 'https://base.blockscout.com/api/v2';

const CONTRACTS = {
  registry: 'contracts/indexio/IndexioAssetRegistry.sol:IndexioAssetRegistry',
  vaultDeployer: 'contracts/indexio/IndexioVaultDeployer.sol:IndexioVaultDeployer',
  factory: 'contracts/indexio/IndexioFactory.sol:IndexioFactory',
  executionRouter: 'contracts/indexio/IndexioExecutionRouter.sol:IndexioExecutionRouter',
  rebalanceRouter: 'contracts/indexio/IndexioRebalanceRouter.sol:IndexioRebalanceRouter',
} as const;

type ContractKind = keyof typeof CONTRACTS;

async function readJson(res: Response) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { message: text || `HTTP ${res.status}` }; }
}

async function isVerified(address: string, key: string) {
  // Prefer Blockscout's chain-local v2 contract endpoint. It reflects published
  // source state directly and avoids treating a missing legacy field as verified.
  try {
    const v2 = await fetch(`${BASE_V2}/smart-contracts/${address}`, {
      headers: key ? { authorization: `Bearer ${key}` } : undefined,
      cache: 'no-store',
    });
    if (v2.ok) {
      const json = await readJson(v2);
      if (json?.is_verified === true || json?.isVerified === true) return true;
      const source = String(json?.source_code || json?.sourceCode || '');
      const name = String(json?.name || json?.contract_name || json?.contractName || '');
      if (source.length > 0 && name.length > 0) return true;
    }
  } catch {
    // Fall through to the legacy-compatible endpoint.
  }

  const params = new URLSearchParams({
    module: 'contract',
    action: 'getsourcecode',
    address,
    apikey: key,
  });
  const res = await fetch(`${BASE_API}?${params.toString()}`, { cache: 'no-store' });
  if (!res.ok) return false;
  const json = await readJson(res);
  const first = Array.isArray(json?.result) ? json.result[0] : undefined;
  const source = String(first?.SourceCode || first?.sourceCode || '');
  const name = String(first?.ContractName || first?.contractName || '');
  return source.length > 0 || name.length > 0;
}

async function submitVerification(params: URLSearchParams, key: string) {
  const endpoints = [
    { url: UNIFIED_API, unified: true },
    { url: BASE_API, unified: false },
  ];

  const errors: string[] = [];
  for (const endpoint of endpoints) {
    const body = new URLSearchParams(params);
    if (endpoint.unified) body.set('chain_id', String(CHAIN_ID));
    else body.delete('chain_id');

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

      if (res.ok && (status !== '0' || /already verified|already been verified/i.test(message))) {
        return { ok: true, message };
      }
      errors.push(`${endpoint.unified ? 'Blockscout unified API' : 'Base Blockscout API'}: ${message}`);
    } catch (error) {
      errors.push(`${endpoint.unified ? 'Blockscout unified API' : 'Base Blockscout API'}: ${error instanceof Error ? error.message : 'request failed'}`);
    }
  }

  return { ok: false, message: errors.join(' | ') || 'Blockscout verification submission failed.' };
}

export async function POST(req: NextRequest) {
  try {
    const key = process.env.BLOCKSCOUT_API_KEY || '';
    const { kind, address, constructorArguments = '', mode = 'verify' } = await req.json();
    if (typeof kind !== 'string' || !(kind in CONTRACTS)) return NextResponse.json({ error: 'Unknown Indexio contract kind.' }, { status: 400 });
    if (!isAddress(address)) return NextResponse.json({ error: 'Valid deployed contract address required.' }, { status: 400 });

    if (await isVerified(address, key)) {
      return NextResponse.json({ ok: true, verified: true, message: 'Contract is verified on Base Blockscout.' });
    }

    if (mode === 'check') {
      return NextResponse.json({
        ok: true,
        verified: false,
        message: 'Blockscout has not published the source yet. This contract is already deployed; use Retry verification to resubmit the source without sending a blockchain transaction.',
      });
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

    const submitted = await submitVerification(params, key);
    if (!submitted.ok) {
      return NextResponse.json({
        error: `Verification submission was not accepted. ${submitted.message}`,
        deployed: true,
        verified: false,
      }, { status: 422 });
    }

    // Poll only the explorer. Verification never triggers another deployment.
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      if (await isVerified(address, key)) {
        return NextResponse.json({ ok: true, verified: true, message: 'Contract verified and source published on Base Blockscout.' });
      }
    }

    return NextResponse.json({
      ok: true,
      verified: false,
      message: `${submitted.message} Blockscout accepted the verification request but source publication is still pending. No redeployment is required.`,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Indexio verification failed.' }, { status: 500 });
  }
}
