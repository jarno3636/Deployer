import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { indexioV3StandardJsonInput } from '../../../../lib/indexio-v3-verification.generated';

export const runtime = 'nodejs';

const BASE_BLOCKSCOUT = 'https://base.blockscout.com';
const BLOCKSCOUT_UNIFIED = 'https://api.blockscout.com/v2/api';
const BASE_CHAIN_ID = '8453';
const BASE_RPC = process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org';
const COMPILER = 'v0.8.30+commit.73712a01';
const CONTRACTS = {
  governanceConfig: { fq: 'contracts/indexio-v3/IndexioGovernanceConfigV3.sol:IndexioGovernanceConfigV3', name: 'IndexioGovernanceConfigV3' },
  safetyController: { fq: 'contracts/indexio-v3/IndexioSafetyControllerV3.sol:IndexioSafetyControllerV3', name: 'IndexioSafetyControllerV3' },
  factory: { fq: 'contracts/indexio-v3/IndexioFactoryV3.sol:IndexioFactoryV3', name: 'IndexioFactoryV3' },
  vaultDeployer: { fq: 'contracts/indexio-v3/IndexioVaultDeployerV3.sol:IndexioVaultDeployerV3', name: 'IndexioVaultDeployerV3' },
  executionRouter: { fq: 'contracts/indexio-v3/IndexioExecutionRouterV3.sol:IndexioExecutionRouterV3', name: 'IndexioExecutionRouterV3' },
  restrictedSwapAdapter: { fq: 'contracts/indexio-v3/IndexioRestrictedSwapAdapterV3.sol:IndexioRestrictedSwapAdapterV3', name: 'IndexioRestrictedSwapAdapterV3' },
  lifiSwapAdapter: { fq: 'contracts/indexio-v3/IndexioLifiSwapAdapterV3.sol:IndexioLifiSwapAdapterV3', name: 'IndexioLifiSwapAdapterV3' },
} as const;

type ContractKind = keyof typeof CONTRACTS;

async function readJson(res: Response) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { message: text || res.statusText, __nonJson: true }; }
}

function isHtml(value: unknown) {
  const s = String(value || '').trim().toLowerCase();
  return s.startsWith('<!doctype html') || s.startsWith('<html') || s.includes('<head>') || s.includes('<body>');
}

function cleanMessage(value: unknown, fallback: string) {
  const s = String(value || '').trim();
  if (!s || isHtml(s)) return fallback;
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}

async function isVerified(address: string) {
  try {
    const res = await fetch(`${BASE_BLOCKSCOUT}/api/v2/smart-contracts/${address}`, {
      cache: 'no-store',
      headers: { accept: 'application/json', 'user-agent': 'Indexio-V3.2-Verifier/1.0' },
    });
    if (!res.ok) return false;
    const body = await readJson(res);
    return body?.is_verified === true || body?.isVerified === true || String(body?.source_code || '').length > 0;
  } catch { return false; }
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
  } catch { return false; }
}

async function explorerIndexed(address: string) {
  try {
    const res = await fetch(`${BASE_BLOCKSCOUT}/api/v2/addresses/${address}`, {
      cache: 'no-store',
      headers: { accept: 'application/json', 'user-agent': 'Indexio-V3.2-Verifier/1.0' },
    });
    if (!res.ok) return false;
    const body = await readJson(res);
    return Boolean(body?.is_contract === true || body?.isContract === true || body?.creation_tx_hash || body?.creationTxHash || body?.contract_code || body?.is_verified === true);
  } catch { return false; }
}

async function verifyViaV2(address: string, kind: ContractKind, constructorArguments: string) {
  const contract = CONTRACTS[kind];
  const form = new FormData();
  form.append('compiler_version', COMPILER);
  form.append('contract_name', contract.name);
  form.append('autodetect_constructor_args', 'false');
  form.append('constructor_args', constructorArguments.replace(/^0x/, ''));
  form.append('files[0]', new Blob([indexioV3StandardJsonInput], { type: 'application/json' }), 'indexio-v3-standard-input.json');
  const res = await fetch(`${BASE_BLOCKSCOUT}/api/v2/smart-contracts/${address}/verification/via/standard-input`, {
    method: 'POST', body: form, cache: 'no-store', headers: { accept: 'application/json', 'user-agent': 'Indexio-V3.2-Verifier/1.0' },
  });
  const body = await readJson(res);
  return { ok: res.ok && !body?.__nonJson, status: res.status, body };
}

async function verifyViaLegacy(address: string, kind: ContractKind, constructorArguments: string) {
  const contract = CONTRACTS[kind];
  const params = new URLSearchParams({
    module: 'contract', action: 'verifysourcecode', codeformat: 'solidity-standard-json-input',
    contractaddress: address, contractname: contract.fq, compilerversion: COMPILER,
    sourceCode: indexioV3StandardJsonInput, constructorArguments: constructorArguments.replace(/^0x/, ''),
  });
  const res = await fetch(`${BASE_BLOCKSCOUT}/api`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'Indexio-V3.2-Verifier/1.0' },
    body: params.toString(), cache: 'no-store',
  });
  const body = await readJson(res);
  const message = String(body?.result || body?.message || '');
  const accepted = res.ok && !body?.__nonJson && (String(body?.status ?? '1') !== '0' || /already verified|already been verified/i.test(message));
  return { ok: accepted, status: res.status, body };
}

async function verifyViaUnified(address: string, kind: ContractKind, constructorArguments: string) {
  const contract = CONTRACTS[kind];
  const params = new URLSearchParams({
    chain_id: BASE_CHAIN_ID, module: 'contract', action: 'verifysourcecode', codeformat: 'solidity-standard-json-input',
    contractaddress: address, contractname: contract.fq, compilerversion: COMPILER,
    sourceCode: indexioV3StandardJsonInput, constructorArguments: constructorArguments.replace(/^0x/, ''),
  });
  const key = process.env.BLOCKSCOUT_API_KEY || '';
  if (key) params.set('apikey', key);
  const res = await fetch(BLOCKSCOUT_UNIFIED, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'Indexio-V3.2-Verifier/1.0', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: params.toString(), cache: 'no-store',
  });
  const body = await readJson(res);
  const message = String(body?.result || body?.message || '');
  const accepted = res.ok && !body?.__nonJson && (String(body?.status ?? '1') !== '0' || /already verified|already been verified/i.test(message));
  return { ok: accepted, status: res.status, body };
}

function safeAttempt(method: string, status: number, body: any) {
  const message = cleanMessage(body?.result || body?.message || body?.error, 'Non-JSON response from verification provider.');
  return { method, status, message };
}

export async function POST(req: NextRequest) {
  try {
    const { kind, address, constructorArguments = '', mode = 'verify' } = await req.json();
    if (!(kind in CONTRACTS) || !isAddress(address)) return NextResponse.json({ error: 'Valid V3 contract kind/address required.' }, { status: 400 });

    if (await isVerified(address)) return NextResponse.json({ ok: true, verified: true, message: 'Verified on Base Blockscout.' });

    const deployed = await hasCodeOnBase(address);
    if (!deployed) return NextResponse.json({ error: 'No contract bytecode is visible at this address on Base. Check the recorded deployment address; do not redeploy until the address is confirmed.', deployed: false }, { status: 409 });

    const indexed = await explorerIndexed(address);
    if (mode === 'check') return NextResponse.json({
      ok: true, verified: false, deployed: true, indexed,
      message: indexed
        ? 'Contract is deployed and visible to Blockscout; source verification is still processing.'
        : 'Contract bytecode is confirmed on Base. Blockscout indexing is still catching up. Check again shortly; do not redeploy.',
    });

    const attempts: Array<{method:string;status:number;message:string}> = [];
    let accepted = false;
    for (let pass = 0; pass < 2 && !accepted; pass++) {
      const v2 = await verifyViaV2(address, kind as ContractKind, String(constructorArguments));
      attempts.push(safeAttempt(`base-v2-${pass+1}`, v2.status, v2.body));
      if (v2.ok) { accepted = true; break; }

      const legacy = await verifyViaLegacy(address, kind as ContractKind, String(constructorArguments));
      attempts.push(safeAttempt(`base-legacy-${pass+1}`, legacy.status, legacy.body));
      if (legacy.ok) { accepted = true; break; }

      const unified = await verifyViaUnified(address, kind as ContractKind, String(constructorArguments));
      attempts.push(safeAttempt(`unified-${pass+1}`, unified.status, unified.body));
      if (unified.ok) { accepted = true; break; }
      if (pass === 0) await new Promise(resolve => setTimeout(resolve, 1800));
    }

    if (!accepted) {
      const last = attempts[attempts.length - 1];
      return NextResponse.json({
        error: `Contract is deployed on Base, but Blockscout has not accepted the source verification yet. ${last?.message || 'Retry verification on this same address; do not redeploy.'}`,
        deployed: true, indexed, attempts,
      }, { status: 422 });
    }

    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (await isVerified(address)) return NextResponse.json({ ok: true, verified: true, message: 'Verified and published on Base Blockscout.' });
    }

    return NextResponse.json({
      ok: true, verified: false, deployed: true, indexed: true,
      message: 'Verification was accepted by Blockscout and is still processing. Tap “Check verification status” shortly; do not redeploy.',
    });
  } catch (error) {
    return NextResponse.json({ error: cleanMessage(error instanceof Error ? error.message : '', 'Verification failed. Retry on the same deployed address.') }, { status: 500 });
  }
}
