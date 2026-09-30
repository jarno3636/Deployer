'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
} from 'viem';
import { base } from 'viem/chains';
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import {
  indexioReinvestmentRouterAbi,
  indexioReinvestmentRouterBytecode,
  indexioReinvestmentRouterCreationBytes,
  indexioReinvestmentRouterRuntimeBytes,
} from '../lib/indexio.generated';
import {
  indexioRestrictedSwapAdapterAbi,
  indexioRestrictedSwapAdapterBytecode,
  indexioRestrictedSwapAdapterCreationBytes,
  indexioRestrictedSwapAdapterRuntimeBytes,
} from '../lib/indexio-adapter.generated';

const FACTORY = getAddress('0xA61BA815E45F522ABaE1cC361d9104F26E015426');
const BASE_USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const LIFI_DIAMOND = getAddress('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE');
const EXPLORER = 'https://base.blockscout.com';
const STORAGE_KEY = 'indexio-v2.4:reinvestment-extension:base';

const factoryAdminAbi = parseAbi([
  'function owner() view returns (address)',
  'function isIndexVault(address vault) view returns (bool)',
  'function isRebalanceRouter(address router) view returns (bool)',
  'function pendingRebalanceRouterValidAt(address router) view returns (uint256)',
  'function proposeRebalanceRouter(address router)',
  'function activateRebalanceRouter(address router)',
  'function isIncomeSource(address vault,address source) view returns (bool)',
  'function pendingIncomeSourceValidAt(address vault,address source) view returns (uint256)',
  'function proposeIncomeSource(address vault,address source)',
  'function activateIncomeSource(address vault,address source)',
]);

const reinvestmentAdminAbi = parseAbi([
  'function owner() view returns (address)',
  'function factory() view returns (address)',
  'function settlementToken() view returns (address)',
  'function approvedAdapter(address adapter) view returns (bool)',
  'function adapterValidAt(address adapter) view returns (uint256)',
  'function proposeAdapter(address adapter)',
  'function activateAdapter(address adapter)',
]);

const adapterAdminAbi = parseAbi([
  'function owner() view returns (address)',
  'function callerRouter() view returns (address)',
  'function allowedTarget(address target) view returns (bool)',
  'function allowedSpender(address spender) view returns (bool)',
  'function pendingTargetValidAt(address target) view returns (uint256)',
  'function pendingSpenderValidAt(address spender) view returns (uint256)',
  'function proposeTarget(address target)',
  'function proposeSpender(address spender)',
  'function activateTarget(address target)',
  'function activateSpender(address spender)',
]);

type Saved = {
  router?: `0x${string}`;
  adapter?: `0x${string}`;
  routerVerified?: boolean;
  adapterVerified?: boolean;
  vault?: `0x${string}`;
};

type Status = {
  factoryOwner?: `0x${string}`;
  routerAdapterAt?: bigint;
  adapterTargetAt?: bigint;
  adapterSpenderAt?: bigint;
  factoryRouterAt?: bigint;
  routerAdapterActive?: boolean;
  adapterTargetActive?: boolean;
  adapterSpenderActive?: boolean;
  factoryRouterActive?: boolean;
  vaultIncomeAt?: bigint;
  vaultIncomeActive?: boolean;
  vaultValid?: boolean;
};

function fmtTime(v?: bigint) {
  if (!v || v === 0n) return 'Not proposed';
  return new Date(Number(v) * 1000).toLocaleString();
}
function short(v?: string) {
  return v ? `${v.slice(0, 8)}…${v.slice(-6)}` : '—';
}

export function IndexioReinvestmentDeployer() {
  const { address, chainId } = useAccount();
  const { data: walletClient } = useWalletClient({ chainId: base.id });
  const publicClient = usePublicClient({ chainId: base.id });
  const { switchChainAsync } = useSwitchChain();

  const [saved, setSaved] = useState<Saved>({});
  const [status, setStatus] = useState<Status>({});
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [recoveryRouter, setRecoveryRouter] = useState('');
  const [recoveryAdapter, setRecoveryAdapter] = useState('');
  const [vaultInput, setVaultInput] = useState('');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Saved;
      setSaved(parsed);
      if (parsed.vault) setVaultInput(parsed.vault);
    } catch {}
  }, []);

  function persist(next: Saved) {
    setSaved(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  const ownerWallet = useMemo(() => {
    if (!address || !status.factoryOwner) return false;
    return address.toLowerCase() === status.factoryOwner.toLowerCase();
  }, [address, status.factoryOwner]);

  async function ensureOwner() {
    if (!address || !walletClient || !publicClient) throw new Error('Connect the current Indexio Factory owner wallet first.');
    if (chainId !== base.id) await switchChainAsync({ chainId: base.id });
    const factoryOwner = getAddress(String(await publicClient.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'owner' })));
    setStatus((s) => ({ ...s, factoryOwner }));
    if (address.toLowerCase() !== factoryOwner.toLowerCase()) {
      throw new Error(`Wrong wallet. Factory owner is ${factoryOwner}; connected wallet is ${address}.`);
    }
    return { account: address, factoryOwner };
  }

  async function writeOne(to: `0x${string}`, abi: readonly unknown[], functionName: string, args: readonly unknown[], label: string) {
    const { account } = await ensureOwner();
    const data = encodeFunctionData({ abi: abi as any, functionName: functionName as any, args: args as any });
    const estimate = await publicClient!.estimateGas({ account, to, data });
    const gas = (estimate * 120n + 99n) / 100n;
    setNotice(`${label} · preflight PASS · opening wallet…`);
    const hash = await walletClient!.sendTransaction({ account, chain: base, to, data, gas });
    const receipt = await publicClient!.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error(`${label} reverted.`);
    return hash;
  }

  async function refresh() {
    if (!publicClient) return;
    setBusy('refresh'); setError('');
    try {
      const factoryOwner = getAddress(String(await publicClient.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'owner' })));
      const next: Status = { factoryOwner };
      if (saved.router) {
        const [adapterAt, routerActive] = await Promise.all([
          saved.adapter ? publicClient.readContract({ address: saved.router, abi: reinvestmentAdminAbi, functionName: 'adapterValidAt', args: [saved.adapter] }) : 0n,
          publicClient.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'isRebalanceRouter', args: [saved.router] }),
        ]);
        next.routerAdapterAt = BigInt(adapterAt as bigint);
        next.factoryRouterActive = Boolean(routerActive);
        next.factoryRouterAt = BigInt(await publicClient.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'pendingRebalanceRouterValidAt', args: [saved.router] }));
        if (saved.adapter) {
          next.routerAdapterActive = Boolean(await publicClient.readContract({ address: saved.router, abi: reinvestmentAdminAbi, functionName: 'approvedAdapter', args: [saved.adapter] }));
          const [targetAt, spenderAt, targetActive, spenderActive] = await Promise.all([
            publicClient.readContract({ address: saved.adapter, abi: adapterAdminAbi, functionName: 'pendingTargetValidAt', args: [LIFI_DIAMOND] }),
            publicClient.readContract({ address: saved.adapter, abi: adapterAdminAbi, functionName: 'pendingSpenderValidAt', args: [LIFI_DIAMOND] }),
            publicClient.readContract({ address: saved.adapter, abi: adapterAdminAbi, functionName: 'allowedTarget', args: [LIFI_DIAMOND] }),
            publicClient.readContract({ address: saved.adapter, abi: adapterAdminAbi, functionName: 'allowedSpender', args: [LIFI_DIAMOND] }),
          ]);
          next.adapterTargetAt = BigInt(targetAt);
          next.adapterSpenderAt = BigInt(spenderAt);
          next.adapterTargetActive = Boolean(targetActive);
          next.adapterSpenderActive = Boolean(spenderActive);
        }
      }
      const vaultRaw = vaultInput.trim();
      if (saved.router && isAddress(vaultRaw)) {
        const vault = getAddress(vaultRaw);
        next.vaultValid = Boolean(await publicClient.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'isIndexVault', args: [vault] }));
        if (next.vaultValid) {
          next.vaultIncomeAt = BigInt(await publicClient.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'pendingIncomeSourceValidAt', args: [vault, saved.router] }));
          next.vaultIncomeActive = Boolean(await publicClient.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'isIncomeSource', args: [vault, saved.router] }));
        }
      }
      setStatus(next);
      setNotice('On-chain reinvestment setup status refreshed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not refresh reinvestment setup.');
    } finally { setBusy(''); }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [publicClient, saved.router, saved.adapter]);

  async function verifyRouter(router: `0x${string}`, owner: `0x${string}`) {
    const constructorArguments = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
      [owner, FACTORY, BASE_USDC],
    );
    const res = await fetch('/api/blockscout/verify-indexio', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'reinvestmentRouter', address: router, constructorArguments }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || 'Reinvestment Router verification failed.');
    return json?.verified === true;
  }

  async function deployRouter() {
    setBusy('deploy-router'); setError(''); setNotice('');
    try {
      if (saved.router) throw new Error('A Reinvestment Router is already saved. Recover/verify it instead of deploying another.');
      const { account, factoryOwner } = await ensureOwner();
      const [factoryCode, usdcCode] = await Promise.all([
        publicClient!.getBytecode({ address: FACTORY }), publicClient!.getBytecode({ address: BASE_USDC }),
      ]);
      if (!factoryCode || factoryCode === '0x') throw new Error('Configured Factory has no bytecode. Stopped before wallet prompt.');
      if (!usdcCode || usdcCode === '0x') throw new Error('Base USDC has no bytecode. Stopped before wallet prompt.');
      const data = encodeDeployData({
        abi: indexioReinvestmentRouterAbi,
        bytecode: indexioReinvestmentRouterBytecode,
        args: [factoryOwner, FACTORY, BASE_USDC],
      });
      const estimate = await publicClient!.estimateGas({ account, data });
      const gas = (estimate * 120n + 99n) / 100n;
      setNotice(`Reinvestment Router preflight PASS · estimated gas ${estimate.toLocaleString()} · opening one deployment transaction.`);
      const hash = await walletClient!.sendTransaction({ account, chain: base, data, gas });
      const receipt = await publicClient!.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Reinvestment Router deployment failed.');
      const router = getAddress(receipt.contractAddress);
      const [owner, factory, settlement] = await Promise.all([
        publicClient!.readContract({ address: router, abi: reinvestmentAdminAbi, functionName: 'owner' }),
        publicClient!.readContract({ address: router, abi: reinvestmentAdminAbi, functionName: 'factory' }),
        publicClient!.readContract({ address: router, abi: reinvestmentAdminAbi, functionName: 'settlementToken' }),
      ]);
      if (String(owner).toLowerCase() !== factoryOwner.toLowerCase()) throw new Error('Router owner validation failed.');
      if (String(factory).toLowerCase() !== FACTORY.toLowerCase()) throw new Error('Router Factory validation failed.');
      if (String(settlement).toLowerCase() !== BASE_USDC.toLowerCase()) throw new Error('Router USDC validation failed.');
      persist({ ...saved, router, routerVerified: false });
      setNotice(`Reinvestment Router deployed and validated at ${router}. Submitting Blockscout verification…`);
      const verified = await verifyRouter(router, factoryOwner);
      persist({ ...saved, router, routerVerified: verified });
      setNotice(verified ? 'Reinvestment Router deployed, validated and verified. Next: deploy its dedicated swap adapter.' : 'Router deployed and validated. Verification is still publishing; do NOT redeploy it.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Router deployment failed.'); }
    finally { setBusy(''); }
  }

  async function recoverRouter() {
    setBusy('recover-router'); setError(''); setNotice('');
    try {
      const { factoryOwner } = await ensureOwner();
      if (!isAddress(recoveryRouter)) throw new Error('Enter a valid existing Reinvestment Router address.');
      const router = getAddress(recoveryRouter);
      const code = await publicClient!.getBytecode({ address: router });
      if (!code || code === '0x') throw new Error('No contract bytecode found at that address.');
      const [owner, factory, settlement] = await Promise.all([
        publicClient!.readContract({ address: router, abi: reinvestmentAdminAbi, functionName: 'owner' }),
        publicClient!.readContract({ address: router, abi: reinvestmentAdminAbi, functionName: 'factory' }),
        publicClient!.readContract({ address: router, abi: reinvestmentAdminAbi, functionName: 'settlementToken' }),
      ]);
      if (String(owner).toLowerCase() !== factoryOwner.toLowerCase() || String(factory).toLowerCase() !== FACTORY.toLowerCase() || String(settlement).toLowerCase() !== BASE_USDC.toLowerCase()) {
        throw new Error('Existing contract does not match the expected Indexio reinvestment configuration.');
      }
      const verified = await verifyRouter(router, factoryOwner);
      persist({ ...saved, router, routerVerified: verified });
      setNotice(`Recovered and validated Reinvestment Router ${router}. No deployment transaction was sent.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Router recovery failed.'); }
    finally { setBusy(''); }
  }

  async function verifyAdapter(adapter: `0x${string}`, owner: `0x${string}`, router: `0x${string}`) {
    const constructorArguments = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [owner, router]);
    const res = await fetch('/api/blockscout/verify-indexio-adapter', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: adapter, constructorArguments }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || 'Reinvestment Adapter verification failed.');
    return json?.verified === true;
  }

  async function deployAdapter() {
    setBusy('deploy-adapter'); setError(''); setNotice('');
    try {
      if (!saved.router) throw new Error('Deploy/recover the Reinvestment Router first.');
      if (saved.adapter) throw new Error('A dedicated Reinvestment Adapter is already saved. Do not deploy another.');
      const { account, factoryOwner } = await ensureOwner();
      const routerCode = await publicClient!.getBytecode({ address: saved.router });
      if (!routerCode || routerCode === '0x') throw new Error('Saved Reinvestment Router has no bytecode.');
      const data = encodeDeployData({
        abi: indexioRestrictedSwapAdapterAbi,
        bytecode: indexioRestrictedSwapAdapterBytecode,
        args: [factoryOwner, saved.router],
      });
      const estimate = await publicClient!.estimateGas({ account, data });
      const gas = (estimate * 120n + 99n) / 100n;
      setNotice(`Dedicated Reinvestment Adapter preflight PASS · estimated gas ${estimate.toLocaleString()} · opening one deployment transaction.`);
      const hash = await walletClient!.sendTransaction({ account, chain: base, data, gas });
      const receipt = await publicClient!.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Reinvestment Adapter deployment failed.');
      const adapter = getAddress(receipt.contractAddress);
      const [owner, caller] = await Promise.all([
        publicClient!.readContract({ address: adapter, abi: adapterAdminAbi, functionName: 'owner' }),
        publicClient!.readContract({ address: adapter, abi: adapterAdminAbi, functionName: 'callerRouter' }),
      ]);
      if (String(owner).toLowerCase() !== factoryOwner.toLowerCase()) throw new Error('Adapter owner validation failed.');
      if (String(caller).toLowerCase() !== saved.router.toLowerCase()) throw new Error('Adapter router binding validation failed.');
      persist({ ...saved, adapter, adapterVerified: false });
      const verified = await verifyAdapter(adapter, factoryOwner, saved.router);
      persist({ ...saved, adapter, adapterVerified: verified });
      setNotice(verified ? 'Dedicated Reinvestment Adapter deployed, bound to the new router, and verified.' : 'Adapter deployed and validated. Verification is still publishing; do NOT redeploy it.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Adapter deployment failed.'); }
    finally { setBusy(''); }
  }

  async function recoverAdapter() {
    setBusy('recover-adapter'); setError(''); setNotice('');
    try {
      if (!saved.router) throw new Error('Recover the Reinvestment Router first.');
      const { factoryOwner } = await ensureOwner();
      if (!isAddress(recoveryAdapter)) throw new Error('Enter a valid existing Reinvestment Adapter address.');
      const adapter = getAddress(recoveryAdapter);
      const code = await publicClient!.getBytecode({ address: adapter });
      if (!code || code === '0x') throw new Error('No contract bytecode found at that address.');
      const [owner, caller] = await Promise.all([
        publicClient!.readContract({ address: adapter, abi: adapterAdminAbi, functionName: 'owner' }),
        publicClient!.readContract({ address: adapter, abi: adapterAdminAbi, functionName: 'callerRouter' }),
      ]);
      if (String(owner).toLowerCase() !== factoryOwner.toLowerCase() || String(caller).toLowerCase() !== saved.router.toLowerCase()) {
        throw new Error('Existing adapter does not match the Factory owner + saved Reinvestment Router.');
      }
      const verified = await verifyAdapter(adapter, factoryOwner, saved.router);
      persist({ ...saved, adapter, adapterVerified: verified });
      setNotice(`Recovered and validated Reinvestment Adapter ${adapter}. No deployment transaction was sent.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Adapter recovery failed.'); }
    finally { setBusy(''); }
  }

  async function startSafetyDelays() {
    setBusy('propose'); setError(''); setNotice('');
    try {
      if (!saved.router || !saved.adapter) throw new Error('Router and dedicated adapter must both be deployed first.');
      await ensureOwner();
      const lifiCode = await publicClient!.getBytecode({ address: LIFI_DIAMOND });
      if (!lifiCode || lifiCode === '0x') throw new Error('Configured LI.FI Diamond has no bytecode. Stopped before proposing permissions.');

      const targetActive = Boolean(await publicClient!.readContract({ address: saved.adapter, abi: adapterAdminAbi, functionName: 'allowedTarget', args: [LIFI_DIAMOND] }));
      const targetAt = BigInt(await publicClient!.readContract({ address: saved.adapter, abi: adapterAdminAbi, functionName: 'pendingTargetValidAt', args: [LIFI_DIAMOND] }));
      if (!targetActive && targetAt === 0n) await writeOne(saved.adapter, adapterAdminAbi, 'proposeTarget', [LIFI_DIAMOND], '1/3 Propose LI.FI swap target');

      const spenderActive = Boolean(await publicClient!.readContract({ address: saved.adapter, abi: adapterAdminAbi, functionName: 'allowedSpender', args: [LIFI_DIAMOND] }));
      const spenderAt = BigInt(await publicClient!.readContract({ address: saved.adapter, abi: adapterAdminAbi, functionName: 'pendingSpenderValidAt', args: [LIFI_DIAMOND] }));
      if (!spenderActive && spenderAt === 0n) await writeOne(saved.adapter, adapterAdminAbi, 'proposeSpender', [LIFI_DIAMOND], '2/3 Propose LI.FI approval spender');

      const adapterActive = Boolean(await publicClient!.readContract({ address: saved.router, abi: reinvestmentAdminAbi, functionName: 'approvedAdapter', args: [saved.adapter] }));
      const adapterAt = BigInt(await publicClient!.readContract({ address: saved.router, abi: reinvestmentAdminAbi, functionName: 'adapterValidAt', args: [saved.adapter] }));
      if (!adapterActive && adapterAt === 0n) await writeOne(saved.router, reinvestmentAdminAbi, 'proposeAdapter', [saved.adapter], '3/4 Propose dedicated adapter to Reinvestment Router');

      const routerActive = Boolean(await publicClient!.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'isRebalanceRouter', args: [saved.router] }));
      const routerAt = BigInt(await publicClient!.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'pendingRebalanceRouterValidAt', args: [saved.router] }));
      if (!routerActive && routerAt === 0n) await writeOne(FACTORY, factoryAdminAbi, 'proposeRebalanceRouter', [saved.router], '4/4 Propose Reinvestment Router to Factory');
      await refresh();
      setNotice('Safety delays started. No more setup transactions are needed until the displayed activation times arrive.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Safety proposal setup failed.'); }
    finally { setBusy(''); }
  }

  async function activateSafety() {
    setBusy('activate'); setError(''); setNotice('');
    try {
      if (!saved.router || !saved.adapter) throw new Error('Router and adapter are incomplete.');
      await ensureOwner();
      const now = BigInt((await publicClient!.getBlock()).timestamp);

      const targetActive = Boolean(await publicClient!.readContract({ address: saved.adapter, abi: adapterAdminAbi, functionName: 'allowedTarget', args: [LIFI_DIAMOND] }));
      const targetAt = BigInt(await publicClient!.readContract({ address: saved.adapter, abi: adapterAdminAbi, functionName: 'pendingTargetValidAt', args: [LIFI_DIAMOND] }));
      if (!targetActive) {
        if (targetAt === 0n || now < targetAt) throw new Error(`LI.FI target is not ready yet. Earliest activation: ${fmtTime(targetAt)}.`);
        await writeOne(saved.adapter, adapterAdminAbi, 'activateTarget', [LIFI_DIAMOND], '1/4 Activate LI.FI swap target');
      }

      const spenderActive = Boolean(await publicClient!.readContract({ address: saved.adapter, abi: adapterAdminAbi, functionName: 'allowedSpender', args: [LIFI_DIAMOND] }));
      const spenderAt = BigInt(await publicClient!.readContract({ address: saved.adapter, abi: adapterAdminAbi, functionName: 'pendingSpenderValidAt', args: [LIFI_DIAMOND] }));
      if (!spenderActive) {
        if (spenderAt === 0n || now < spenderAt) throw new Error(`LI.FI spender is not ready yet. Earliest activation: ${fmtTime(spenderAt)}.`);
        await writeOne(saved.adapter, adapterAdminAbi, 'activateSpender', [LIFI_DIAMOND], '2/4 Activate LI.FI approval spender');
      }

      const adapterActive = Boolean(await publicClient!.readContract({ address: saved.router, abi: reinvestmentAdminAbi, functionName: 'approvedAdapter', args: [saved.adapter] }));
      const adapterAt = BigInt(await publicClient!.readContract({ address: saved.router, abi: reinvestmentAdminAbi, functionName: 'adapterValidAt', args: [saved.adapter] }));
      if (!adapterActive) {
        if (adapterAt === 0n || now < adapterAt) throw new Error(`Reinvestment Adapter is not ready yet. Earliest activation: ${fmtTime(adapterAt)}.`);
        await writeOne(saved.router, reinvestmentAdminAbi, 'activateAdapter', [saved.adapter], '3/4 Activate dedicated adapter');
      }

      const routerActive = Boolean(await publicClient!.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'isRebalanceRouter', args: [saved.router] }));
      const routerAt = BigInt(await publicClient!.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'pendingRebalanceRouterValidAt', args: [saved.router] }));
      if (!routerActive) {
        if (routerAt === 0n || now < routerAt) throw new Error(`Factory router approval is not ready yet. Earliest activation: ${fmtTime(routerAt)}.`);
        await writeOne(FACTORY, factoryAdminAbi, 'activateRebalanceRouter', [saved.router], '4/4 Activate Reinvestment Router in Factory');
      }
      await refresh();
      setNotice('Core reinvestment extension is ACTIVE. After the first vault exists, authorize that vault in the final card below.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Activation failed.'); }
    finally { setBusy(''); }
  }

  async function proposeVaultIncome() {
    setBusy('vault-propose'); setError(''); setNotice('');
    try {
      if (!saved.router) throw new Error('Reinvestment Router is missing.');
      if (!isAddress(vaultInput.trim())) throw new Error('Enter the deployed Indexio vault address.');
      const vault = getAddress(vaultInput.trim());
      await ensureOwner();
      const valid = Boolean(await publicClient!.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'isIndexVault', args: [vault] }));
      if (!valid) throw new Error('That address is not recognized by the Factory as an Indexio vault.');
      const active = Boolean(await publicClient!.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'isIncomeSource', args: [vault, saved.router] }));
      if (active) {
        persist({ ...saved, vault });
        return setNotice('This vault already authorizes the Reinvestment Router as an income source.');
      }
      const at = BigInt(await publicClient!.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'pendingIncomeSourceValidAt', args: [vault, saved.router] }));
      if (at === 0n) await writeOne(FACTORY, factoryAdminAbi, 'proposeIncomeSource', [vault, saved.router], 'Propose vault income source');
      persist({ ...saved, vault });
      setVaultInput(vault);
      await refresh();
      setNotice('Vault income-source safety delay started. Come back after the displayed activation time.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Vault proposal failed.'); }
    finally { setBusy(''); }
  }

  async function activateVaultIncome() {
    setBusy('vault-activate'); setError(''); setNotice('');
    try {
      if (!saved.router || !isAddress(vaultInput.trim())) throw new Error('Router and valid vault address are required.');
      const vault = getAddress(vaultInput.trim());
      await ensureOwner();
      const active = Boolean(await publicClient!.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'isIncomeSource', args: [vault, saved.router] }));
      if (active) return setNotice('Vault income source is already ACTIVE. No transaction needed.');
      const at = BigInt(await publicClient!.readContract({ address: FACTORY, abi: factoryAdminAbi, functionName: 'pendingIncomeSourceValidAt', args: [vault, saved.router] }));
      const now = BigInt((await publicClient!.getBlock()).timestamp);
      if (at === 0n || now < at) throw new Error(`Vault income-source approval is not ready yet. Earliest activation: ${fmtTime(at)}.`);
      await writeOne(FACTORY, factoryAdminAbi, 'activateIncomeSource', [vault, saved.router], 'Activate vault income source');
      persist({ ...saved, vault });
      await refresh();
      setNotice('Vault is now authorized for the dividend reinvestment path.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Vault activation failed.'); }
    finally { setBusy(''); }
  }

  const setupActive = Boolean(status.adapterTargetActive && status.adapterSpenderActive && status.routerAdapterActive && status.factoryRouterActive);

  return <>
    <section className="card stepCard" style={{ borderColor: 'rgba(87,190,134,.35)', marginTop: 28 }}>
      <div className="stepHead"><span className="stepNo">DRIP</span><div><h2>Dividend Reinvestment Extension</h2><p>This is an add-on to the existing Indexio deployment. It does not redeploy or replace any core contract. The cards below are deliberately sequential and validate every address before opening a wallet transaction.</p></div></div>
      <div className="notice strong"><strong>Only two new contracts:</strong> one Reinvestment Router and one dedicated Restricted Swap Adapter bound only to that router. The existing adapters cannot be reused because each adapter is permanently bound to its original caller router.</div>
      <div className="details">
        <div><span>Factory</span><code>{FACTORY}</code></div>
        <div><span>Settlement</span><code>{BASE_USDC}</code></div>
        <div><span>Factory owner</span><code>{status.factoryOwner || 'Reading on-chain…'}</code></div>
        <div><span>Connected wallet</span><strong>{ownerWallet ? 'CORRECT OWNER' : address ? 'WRONG WALLET' : 'NOT CONNECTED'}</strong></div>
      </div>
      <button className="secondary" disabled={!!busy} onClick={refresh}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh on-chain status'}</button>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">A</span><div><h2>Deploy Reinvestment Router</h2><p>One new contract. Constructor values are locked to the live Factory owner, production Factory, and native Base USDC.</p></div></div>
      <div className="details"><div><span>Init code</span><strong>{indexioReinvestmentRouterCreationBytes.toLocaleString()} bytes</strong></div><div><span>Runtime</span><strong>{indexioReinvestmentRouterRuntimeBytes.toLocaleString()} bytes</strong></div>{saved.router && <div><span>Router</span><code>{saved.router}</code></div>}</div>
      {!saved.router ? <>
        <button className="primary deploy" disabled={!!busy || !ownerWallet} onClick={deployRouter}>{busy === 'deploy-router' ? 'Preflighting + deploying…' : 'Deploy + validate Reinvestment Router'}</button>
        <div className="notice"><strong>Already deployed it?</strong> Recover instead of redeploying.<label className="field" style={{ marginTop: 10 }}>EXISTING ROUTER ADDRESS<input value={recoveryRouter} onChange={(e) => setRecoveryRouter(e.target.value.trim())} placeholder="0x…" /></label><button className="secondary" disabled={!!busy || !recoveryRouter} onClick={recoverRouter}>Use existing router</button></div>
      </> : <div className="notice success">✓ Router saved. <a href={`${EXPLORER}/address/${saved.router}`} target="_blank" rel="noreferrer">Open on Blockscout ↗</a></div>}
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">B</span><div><h2>Deploy dedicated Reinvestment Adapter</h2><p>The deployer binds this adapter directly to the new Reinvestment Router. This prevents another router from using its swap permissions.</p></div></div>
      <div className="details"><div><span>Init code</span><strong>{indexioRestrictedSwapAdapterCreationBytes.toLocaleString()} bytes</strong></div><div><span>Runtime</span><strong>{indexioRestrictedSwapAdapterRuntimeBytes.toLocaleString()} bytes</strong></div>{saved.adapter && <div><span>Adapter</span><code>{saved.adapter}</code></div>}</div>
      {!saved.adapter ? <>
        <button className="primary deploy" disabled={!!busy || !saved.router || !ownerWallet} onClick={deployAdapter}>{busy === 'deploy-adapter' ? 'Preflighting + deploying…' : 'Deploy + bind dedicated adapter'}</button>
        <div className="notice"><strong>Already deployed it?</strong> Recovery validates that <code>callerRouter</code> equals the saved Reinvestment Router.<label className="field" style={{ marginTop: 10 }}>EXISTING ADAPTER ADDRESS<input value={recoveryAdapter} onChange={(e) => setRecoveryAdapter(e.target.value.trim())} placeholder="0x…" /></label><button className="secondary" disabled={!!busy || !recoveryAdapter || !saved.router} onClick={recoverAdapter}>Use existing adapter</button></div>
      </> : <div className="notice success">✓ Dedicated adapter saved. <a href={`${EXPLORER}/address/${saved.adapter}`} target="_blank" rel="noreferrer">Open on Blockscout ↗</a></div>}
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">C</span><div><h2>Start all safety delays</h2><p>One guided button handles the four required proposals and skips anything already proposed or active. Expect up to four wallet confirmations.</p></div></div>
      <div className="details">
        <div><span>LI.FI target</span><strong>{status.adapterTargetActive ? 'ACTIVE' : fmtTime(status.adapterTargetAt)}</strong></div>
        <div><span>LI.FI spender</span><strong>{status.adapterSpenderActive ? 'ACTIVE' : fmtTime(status.adapterSpenderAt)}</strong></div>
        <div><span>Adapter → Router</span><strong>{status.routerAdapterActive ? 'ACTIVE' : fmtTime(status.routerAdapterAt)}</strong></div>
        <div><span>Router → Factory</span><strong>{status.factoryRouterActive ? 'ACTIVE' : fmtTime(status.factoryRouterAt)}</strong></div>
      </div>
      <div className="notice">The trusted swap target/spender is the same production LI.FI Diamond already used by Indexio: <code>{LIFI_DIAMOND}</code>. The deployer checks bytecode before proposing it.</div>
      <button className="primary" disabled={!!busy || !saved.router || !saved.adapter || !ownerWallet} onClick={startSafetyDelays}>{busy === 'propose' ? 'Running guided proposals…' : 'Start safety delays'}</button>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">D</span><div><h2>Activate after the delays</h2><p>The LI.FI + adapter permissions mature after 1 day; the Factory router approval matures after its governance delay. This button refuses to run early and skips anything already active.</p></div></div>
      {setupActive ? <div className="notice success">✓ Core dividend reinvestment extension ACTIVE.</div> : <button className="secondary" disabled={!!busy || !saved.router || !saved.adapter || !ownerWallet} onClick={activateSafety}>{busy === 'activate' ? 'Activating ready permissions…' : 'Activate ready permissions'}</button>}
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">E</span><div><h2>Authorize each new index vault</h2><p>You cannot do this until a vault exists. Paste the vault address after launching an index. The deployer verifies it against the Factory before allowing either governance transaction.</p></div></div>
      <label className="field">INDEXIO VAULT ADDRESS<input value={vaultInput} onChange={(e) => setVaultInput(e.target.value.trim())} placeholder="0x…" /></label>
      <div className="details"><div><span>Factory recognizes vault</span><strong>{status.vaultValid === true ? 'YES' : status.vaultValid === false ? 'NO' : 'NOT CHECKED'}</strong></div><div><span>Income source</span><strong>{status.vaultIncomeActive ? 'ACTIVE' : fmtTime(status.vaultIncomeAt)}</strong></div></div>
      <div style={{ display: 'grid', gap: 10 }}>
        <button className="primary" disabled={!!busy || !setupActive || !saved.router || !ownerWallet || !isAddress(vaultInput.trim())} onClick={proposeVaultIncome}>{busy === 'vault-propose' ? 'Proposing…' : '1. Propose vault income source'}</button>
        <button className="secondary" disabled={!!busy || !setupActive || !saved.router || !ownerWallet || !isAddress(vaultInput.trim())} onClick={activateVaultIncome}>{busy === 'vault-activate' ? 'Activating…' : '2. Activate after 1-day delay'}</button>
      </div>
      <div className="notice"><strong>Repeat only this final card for future vaults.</strong> The Router and Adapter are shared infrastructure; they should not be redeployed per index.</div>
    </section>

    {notice && <section className="card"><div className="notice success">{notice}</div></section>}
    {error && <section className="card error"><b>Reinvestment action stopped</b><p>{error}</p></section>}
  </>;
}
