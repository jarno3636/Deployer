import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { indexioV25StandardJsonInput } from '../../../../lib/indexio-v25-verification.generated';

export const runtime = 'nodejs';

const BASE_BLOCKSCOUT = 'https://base.blockscout.com';
const BLOCKSCOUT_UNIFIED = 'https://api.blockscout.com/v2/api';
const BASE_CHAIN_ID = '8453';
const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const COMPILER = 'v0.8.30+commit.73712a01';
const CONTRACTS = {
  vaultDeployer: {
    fq: 'contracts/indexio-v25/IndexioVaultDeployerV25.sol:IndexioVaultDeployerV25',
    name: 'IndexioVaultDeployerV25',
  },
  factory: {
    fq: 'contracts/indexio-v25/IndexioFactoryV25.sol:IndexioFactoryV25',
    name: 'IndexioFactoryV25',
  },
  executionRouter: {
    fq: 'contracts/indexio-v25/IndexioExecutionRouterV25.sol:IndexioExecutionRouterV25',
    name: 'IndexioExecutionRouterV25',
  },
  executionRouterSeed25: {
    fq: 'contracts/indexio-v25/IndexioExecutionRouterV25Seed25.sol:IndexioExecutionRouterV25Seed25',
    name: 'IndexioExecutionRouterV25Seed25',
  },
  rebalanceRouter: {
    fq: 'contracts/indexio-v25/IndexioRebalanceRouterV25.sol:IndexioRebalanceRouterV25',
    name: 'IndexioRebalanceRouterV25',
  },
  reinvestmentRouter: {
    fq: 'contracts/indexio-v25/IndexioReinvestmentRouterV25.sol:IndexioReinvestmentRouterV25',
    name: 'IndexioReinvestmentRouterV25',
  },
  adapter: {
    fq: 'contracts/indexio-v25/IndexioRestrictedSwapAdapterV25.sol:IndexioRestrictedSwapAdapterV25',
    name: 'IndexioRestrictedSwapAdapterV25',
  },
} as const;

type ContractKind = keyof typeof CONTRACTS;

async function readJson(res: Response) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { message: text || res.statusText }; }
}

async function isVerified(address: string) {
  const res = await fetch(`${BASE_BLOCKSCOUT}/api/v2/smart-contracts/${address}`, { cache: 'no-store' });
  if (!res.ok) return false;
  const body = await readJson(res);
  return body?.is_verified === true || body?.isVerified === true || String(body?.source_code || '').length > 0;
}

async function hasCodeOnBase(address: string) {
  try {
    const res = await fetch(BASE_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const body = await readJson(res);
    const code = String(body?.result || '');
    return /^0x[0-9a-fA-F]+$/.test(code) && code !== '0x' && code !== '0x0';
  } catch {
    return false;
  }
}

async function explorerIndexed(address: string) {
  // Informational only. Verification must never be blocked by explorer-index metadata.
  try {
    const res = await fetch(`${BASE_BLOCKSCOUT}/api/v2/addresses/${address}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const body = await readJson(res);
    return Boolean(
      body?.is_contract === true ||
      body?.isContract === true ||
      body?.creation_tx_hash ||
      body?.creationTxHash ||
      body?.contract_code ||
      body?.is_verified === true
    );
  } catch {
    return false;
  }
}

async function verifyViaV2(address: string, kind: ContractKind, constructorArguments: string) {
  const contract = CONTRACTS[kind];
  const form = new FormData();
  form.append('compiler_version', COMPILER);
  form.append('contract_name', contract.name);
  form.append('autodetect_constructor_args', 'false');
  form.append('constructor_args', constructorArguments.replace(/^0x/, ''));
  form.append(
    'files[0]',
    new Blob([indexioV25StandardJsonInput], { type: 'application/json' }),
    'indexio-v25-standard-input.json',
  );

  const res = await fetch(
    `${BASE_BLOCKSCOUT}/api/v2/smart-contracts/${address}/verification/via/standard-input`,
    { method: 'POST', body: form, cache: 'no-store' },
  );
  const body = await readJson(res);
  return { ok: res.ok, status: res.status, body };
}

async function verifyViaLegacy(address: string, kind: ContractKind, constructorArguments: string) {
  const contract = CONTRACTS[kind];
  const params = new URLSearchParams({
    module: 'contract',
    action: 'verifysourcecode',
    codeformat: 'solidity-standard-json-input',
    contractaddress: address,
    contractname: contract.fq,
    compilerversion: COMPILER,
    sourceCode: indexioV25StandardJsonInput,
    constructorArguments: constructorArguments.replace(/^0x/, ''),
  });
  const res = await fetch(`${BASE_BLOCKSCOUT}/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    cache: 'no-store',
  });
  const body = await readJson(res);
  const message = String(body?.result || body?.message || '');
  const accepted = res.ok && (String(body?.status ?? '1') !== '0' || /already verified|already been verified/i.test(message));
  return { ok: accepted, status: res.status, body };
}

async function verifyViaUnified(address: string, kind: ContractKind, constructorArguments: string) {
  const contract = CONTRACTS[kind];
  const params = new URLSearchParams({
    chain_id: BASE_CHAIN_ID,
    module: 'contract',
    action: 'verifysourcecode',
    codeformat: 'solidity-standard-json-input',
    contractaddress: address,
    contractname: contract.fq,
    compilerversion: COMPILER,
    sourceCode: indexioV25StandardJsonInput,
    constructorArguments: constructorArguments.replace(/^0x/, ''),
  });
  const key = process.env.BLOCKSCOUT_API_KEY || '';
  if (key) params.set('apikey', key);
  const res = await fetch(BLOCKSCOUT_UNIFIED, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: params.toString(),
    cache: 'no-store',
  });
  const body = await readJson(res);
  const message = String(body?.result || body?.message || '');
  const accepted = res.ok && (String(body?.status ?? '1') !== '0' || /already verified|already been verified/i.test(message));
  return { ok: accepted, status: res.status, body };
}

function errorMessage(body: any, fallback: string) {
  if (typeof body?.message === 'string' && body.message) return body.message;
  if (typeof body?.result === 'string' && body.result) return body.result;
  if (Array.isArray(body?.errors) && body.errors.length) return body.errors.map((x: any) => x?.detail || x?.title || String(x)).join('; ');
  return fallback;
}

export async function POST(req: NextRequest) {
  try {
    const { kind, address, constructorArguments = '', mode = 'verify' } = await req.json();
    if (!(kind in CONTRACTS) || !isAddress(address)) {
      return NextResponse.json({ error: 'Valid V2.5 contract kind and address required.' }, { status: 400 });
    }

    if (await isVerified(address)) {
      return NextResponse.json({ ok: true, verified: true, message: 'Verified on Base Blockscout.' });
    }

    const deployed = await hasCodeOnBase(address);
    if (!deployed) {
      return NextResponse.json({
        error: 'No contract bytecode is visible at this address on Base. Check the deployment transaction/address before attempting verification.',
        deployed: false,
      }, { status: 409 });
    }

    const indexed = await explorerIndexed(address);
    if (mode === 'check') {
      return NextResponse.json({
        ok: true,
        verified: false,
        deployed: true,
        indexed,
        message: indexed
          ? 'Contract is deployed and visible to Blockscout; source is not verified yet.'
          : 'Contract bytecode is confirmed on Base. Blockscout indexing metadata is still catching up, but verification can be submitted now.',
      });
    }

    // Do not gate source submission on Blockscout's address-index metadata.
    // A successfully deployed contract is authoritative; explorer indexing may lag or expose different fields.
    const attempts: any[] = [];
    let accepted = false;
    for (let pass = 0; pass < 3 && !accepted; pass++) {
      const v2 = await verifyViaV2(address, kind as ContractKind, String(constructorArguments));
      attempts.push({ method: 'base-v2', pass, status: v2.status, body: v2.body });
      if (v2.ok) { accepted = true; break; }

      const legacy = await verifyViaLegacy(address, kind as ContractKind, String(constructorArguments));
      attempts.push({ method: 'base-legacy', pass, status: legacy.status, body: legacy.body });
      if (legacy.ok) { accepted = true; break; }

      const unified = await verifyViaUnified(address, kind as ContractKind, String(constructorArguments));
      attempts.push({ method: 'unified', pass, status: unified.status, body: unified.body });
      if (unified.ok) { accepted = true; break; }

      if (pass < 2) await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    if (!accepted) {
      const last = attempts[attempts.length - 1]?.body;
      return NextResponse.json({
        error: `Contract is confirmed deployed on Base, but Blockscout did not accept the verification submission yet. ${errorMessage(last, 'Retry verification on this same address; do not redeploy.')}`.trim(),
        deployed: true,
        indexed,
        details: attempts,
      }, { status: 422 });
    }

    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      if (await isVerified(address)) {
        return NextResponse.json({ ok: true, verified: true, message: 'Verified and published on Base Blockscout.' });
      }
    }

    return NextResponse.json({
      ok: true,
      verified: false,
      indexed: true,
      message: 'Verification was submitted to Base Blockscout and is still processing. Tap again to recheck this same address; do not redeploy.',
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Verification failed.' }, { status: 500 });
  }
}
