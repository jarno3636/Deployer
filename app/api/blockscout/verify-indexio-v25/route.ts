import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { indexioV25StandardJsonInput } from '../../../../lib/indexio-v25-verification.generated';

export const runtime = 'nodejs';

const BASE_BLOCKSCOUT = 'https://base.blockscout.com';
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

async function isIndexedContract(address: string) {
  const res = await fetch(`${BASE_BLOCKSCOUT}/api/v2/addresses/${address}`, { cache: 'no-store' });
  if (!res.ok) return false;
  const body = await readJson(res);
  return body?.is_contract === true || body?.isContract === true || body?.is_verified === true;
}

async function waitForIndex(address: string) {
  for (let i = 0; i < 8; i++) {
    if (await isIndexedContract(address)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
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
  const form = new FormData();
  form.append('module', 'contract');
  form.append('action', 'verifysourcecode');
  form.append('codeformat', 'solidity-standard-json-input');
  form.append('contractaddress', address);
  form.append('contractname', contract.fq);
  form.append('compilerversion', COMPILER);
  form.append('sourceCode', indexioV25StandardJsonInput);
  form.append('constructorArguments', constructorArguments.replace(/^0x/, ''));

  const res = await fetch(`${BASE_BLOCKSCOUT}/api`, { method: 'POST', body: form, cache: 'no-store' });
  const body = await readJson(res);
  const accepted = res.ok && String(body?.status ?? '1') !== '0';
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

    const indexed = await waitForIndex(address);
    if (!indexed) {
      return NextResponse.json({
        ok: true,
        verified: false,
        indexed: false,
        message: 'Base Blockscout has not indexed this new contract yet. Wait about 15–30 seconds, then tap Verify again. Do not redeploy.',
      });
    }

    if (mode === 'check') {
      return NextResponse.json({ ok: true, verified: false, indexed: true, message: 'Contract is indexed but source is not verified yet.' });
    }

    const v2 = await verifyViaV2(address, kind as ContractKind, String(constructorArguments));
    if (!v2.ok) {
      const legacy = await verifyViaLegacy(address, kind as ContractKind, String(constructorArguments));
      if (!legacy.ok) {
        return NextResponse.json({
          error: `Base Blockscout rejected verification. ${errorMessage(v2.body, '') || errorMessage(legacy.body, '')}`.trim(),
          details: { v2: v2.body, legacy: legacy.body },
          deployed: true,
        }, { status: 422 });
      }
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
