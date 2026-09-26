'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  encodeAbiParameters,
  encodeDeployData,
  getAddress,
  isAddress,
  parseAbi,
} from 'viem';
import { base } from 'viem/chains';
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import {
  indexioRestrictedSwapAdapterAbi,
  indexioRestrictedSwapAdapterBytecode,
  indexioRestrictedSwapAdapterCreationBytes,
  indexioRestrictedSwapAdapterRuntimeBytes,
} from '../lib/indexio-adapter.generated';

const EXECUTION_ROUTER = getAddress('0xAF6c08e1B51c5A3D47da467cBea493A6FF832182');
const REBALANCE_ROUTER = getAddress('0xA763F5930c12bF0a71da66d5e86804CE726A5f46');
const PROTOCOL_OWNER = getAddress('0x3118FE32B27651734fe4D966D1bC240bE6e3139D');
const EXPLORER = 'https://base.blockscout.com';
const STORAGE_KEY = 'indexio-v2.4.1:restricted-adapters:base';

const routerAbi = parseAbi([
  'function owner() view returns (address)',
  'function proposeAdapter(address adapter)',
  'function activateAdapter(address adapter)',
  'function approvedAdapter(address adapter) view returns (bool)',
  'function adapterValidAt(address adapter) view returns (uint256)',
]);

const adapterAdminAbi = parseAbi([
  'function owner() view returns (address)',
  'function callerRouter() view returns (address)',
  'function TRUST_DELAY() view returns (uint256)',
  'function allowedTarget(address) view returns (bool)',
  'function allowedSpender(address) view returns (bool)',
  'function pendingTargetValidAt(address) view returns (uint256)',
  'function pendingSpenderValidAt(address) view returns (uint256)',
  'function proposeTarget(address)',
  'function proposeSpender(address)',
  'function activateTarget(address)',
  'function activateSpender(address)',
]);

type AdapterKind = 'execution' | 'rebalance';
type VerifyState = 'idle' | 'pending' | 'verified' | 'error';

type Saved = {
  executionAdapter?: `0x${string}`;
  rebalanceAdapter?: `0x${string}`;
  executionVerified?: boolean;
  rebalanceVerified?: boolean;
  targets?: string;
  spenders?: string;
};

function parseAddressList(value: string) {
  const out: `0x${string}`[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(/[\n,\s]+/).map((x) => x.trim()).filter(Boolean)) {
    if (!isAddress(raw)) throw new Error(`Invalid address: ${raw}`);
    const address = getAddress(raw);
    if (!seen.has(address.toLowerCase())) {
      seen.add(address.toLowerCase());
      out.push(address);
    }
  }
  return out;
}

function fmtTime(value?: bigint) {
  if (!value || value === 0n) return 'Not proposed';
  return new Date(Number(value) * 1000).toLocaleString();
}

function short(address?: string) {
  return address ? `${address.slice(0, 8)}…${address.slice(-6)}` : '—';
}

export function IndexioAdapterDeployer() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending: connectPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: base.id });

  const [saved, setSaved] = useState<Saved>({});
  const [targetsText, setTargetsText] = useState('');
  const [spendersText, setSpendersText] = useState('');
  const [busy, setBusy] = useState<string>('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [verify, setVerify] = useState<Record<AdapterKind, VerifyState>>({ execution: 'idle', rebalance: 'idle' });
  const [trustStatus, setTrustStatus] = useState<{
    executionTargetAt?: bigint; executionSpenderAt?: bigint;
    rebalanceTargetAt?: bigint; rebalanceSpenderAt?: bigint;
    executionTrustActive?: boolean; rebalanceTrustActive?: boolean;
    executionCoreAt?: bigint; rebalanceCoreAt?: bigint;
    executionCoreActive?: boolean; rebalanceCoreActive?: boolean;
  }>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Saved;
      setSaved(parsed);
      setTargetsText(parsed.targets || '');
      setSpendersText(parsed.spenders || '');
      setVerify({
        execution: parsed.executionVerified ? 'verified' : 'idle',
        rebalance: parsed.rebalanceVerified ? 'verified' : 'idle',
      });
    } catch {}
  }, []);

  function persist(next: Saved) {
    setSaved(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  const isOwnerWallet = !!address && address.toLowerCase() === PROTOCOL_OWNER.toLowerCase();
  const bothDeployed = !!saved.executionAdapter && !!saved.rebalanceAdapter;
  const bothVerified = saved.executionVerified && saved.rebalanceVerified;

  const summary = useMemo(() => ({
    executionAdapter: saved.executionAdapter || '',
    rebalanceAdapter: saved.rebalanceAdapter || '',
  }), [saved]);

  async function ensureBaseAndOwner() {
    if (!address || !walletClient || !publicClient) throw new Error('Connect the protocol-owner wallet first.');
    if (chainId !== base.id) await switchChainAsync({ chainId: base.id });
    if (address.toLowerCase() !== PROTOCOL_OWNER.toLowerCase()) {
      throw new Error(`Governance actions require protocol owner ${PROTOCOL_OWNER}. Connected: ${address}`);
    }
  }

  async function verifyAdapter(kind: AdapterKind, adapter: `0x${string}`, callerRouter: `0x${string}`) {
    setVerify((s) => ({ ...s, [kind]: 'pending' }));
    const args = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }],
      [PROTOCOL_OWNER, callerRouter],
    );
    const res = await fetch('/api/blockscout/verify-indexio-adapter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: adapter, constructorArguments: args }),
    });
    const json = await res.json();
    if (!res.ok) {
      setVerify((s) => ({ ...s, [kind]: 'error' }));
      throw new Error(json?.error || 'Verification submission failed.');
    }
    const verified = json?.verified === true;
    setVerify((s) => ({ ...s, [kind]: verified ? 'verified' : 'pending' }));
    const next: Saved = {
      ...saved,
      ...(kind === 'execution'
        ? { executionAdapter: adapter, executionVerified: verified }
        : { rebalanceAdapter: adapter, rebalanceVerified: verified }),
    };
    persist(next);
    return verified;
  }

  async function deployAdapter(kind: AdapterKind) {
    setError(''); setNotice(''); setBusy(`deploy-${kind}`);
    try {
      await ensureBaseAndOwner();
      if (!publicClient || !walletClient || !address) throw new Error('Wallet unavailable.');
      if (kind === 'rebalance' && !saved.executionAdapter) throw new Error('Deploy and verify the Execution Adapter first.');
      const callerRouter = kind === 'execution' ? EXECUTION_ROUTER : REBALANCE_ROUTER;

      const routerCode = await publicClient.getBytecode({ address: callerRouter });
      if (!routerCode || routerCode === '0x') throw new Error(`Core router has no bytecode: ${callerRouter}`);
      const routerOwner = await publicClient.readContract({ address: callerRouter, abi: routerAbi, functionName: 'owner' });
      if (String(routerOwner).toLowerCase() !== PROTOCOL_OWNER.toLowerCase()) {
        throw new Error(`Unexpected ${kind} router owner: ${routerOwner}`);
      }

      const data = encodeDeployData({
        abi: indexioRestrictedSwapAdapterAbi,
        bytecode: indexioRestrictedSwapAdapterBytecode,
        args: [PROTOCOL_OWNER, callerRouter],
      });
      const estimate = await publicClient.estimateGas({ account: address, data });
      const gas = (estimate * 120n) / 100n;
      setNotice(`Preflight PASS · estimated gas ${estimate.toLocaleString()} · wallet will deploy one ${kind} adapter on Base.`);

      const hash = await walletClient.sendTransaction({ account: address, chain: base, data, gas });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Adapter deployment did not succeed.');
      const adapter = getAddress(receipt.contractAddress);

      const owner = await publicClient.readContract({ address: adapter, abi: adapterAdminAbi, functionName: 'owner' });
      const bound = await publicClient.readContract({ address: adapter, abi: adapterAdminAbi, functionName: 'callerRouter' });
      if (String(owner).toLowerCase() !== PROTOCOL_OWNER.toLowerCase()) throw new Error('Deployed adapter owner validation failed.');
      if (String(bound).toLowerCase() !== callerRouter.toLowerCase()) throw new Error('Deployed adapter callerRouter validation failed.');

      const next: Saved = {
        ...saved,
        ...(kind === 'execution' ? { executionAdapter: adapter, executionVerified: false } : { rebalanceAdapter: adapter, rebalanceVerified: false }),
      };
      persist(next);
      setNotice(`${kind === 'execution' ? 'Execution' : 'Rebalance'} Adapter deployed at ${adapter}. Submitting source verification now.`);
      await verifyAdapter(kind, adapter, callerRouter);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Adapter deployment failed.');
    } finally { setBusy(''); }
  }

  async function retryVerification(kind: AdapterKind) {
    setError(''); setBusy(`verify-${kind}`);
    try {
      const adapter = kind === 'execution' ? saved.executionAdapter : saved.rebalanceAdapter;
      if (!adapter) throw new Error('No adapter address saved.');
      await verifyAdapter(kind, adapter, kind === 'execution' ? EXECUTION_ROUTER : REBALANCE_ROUTER);
    } catch (e) { setError(e instanceof Error ? e.message : 'Verification failed.'); }
    finally { setBusy(''); }
  }

  async function refreshStatus() {
    setError(''); setBusy('refresh');
    try {
      if (!publicClient || !bothDeployed) throw new Error('Deploy both adapters first.');
      const targets = parseAddressList(targetsText);
      const spenders = parseAddressList(spendersText);
      const firstTarget = targets[0];
      const firstSpender = spenders[0];
      const ea = saved.executionAdapter!;
      const ra = saved.rebalanceAdapter!;

      const [executionCoreAt, rebalanceCoreAt, executionCoreActive, rebalanceCoreActive] = await Promise.all([
        publicClient.readContract({ address: EXECUTION_ROUTER, abi: routerAbi, functionName: 'adapterValidAt', args: [ea] }),
        publicClient.readContract({ address: REBALANCE_ROUTER, abi: routerAbi, functionName: 'adapterValidAt', args: [ra] }),
        publicClient.readContract({ address: EXECUTION_ROUTER, abi: routerAbi, functionName: 'approvedAdapter', args: [ea] }),
        publicClient.readContract({ address: REBALANCE_ROUTER, abi: routerAbi, functionName: 'approvedAdapter', args: [ra] }),
      ]);

      let executionTargetAt = 0n, executionSpenderAt = 0n, rebalanceTargetAt = 0n, rebalanceSpenderAt = 0n;
      let executionTrustActive = false, rebalanceTrustActive = false;
      if (firstTarget && firstSpender) {
        [executionTargetAt, executionSpenderAt, rebalanceTargetAt, rebalanceSpenderAt] = await Promise.all([
          publicClient.readContract({ address: ea, abi: adapterAdminAbi, functionName: 'pendingTargetValidAt', args: [firstTarget] }),
          publicClient.readContract({ address: ea, abi: adapterAdminAbi, functionName: 'pendingSpenderValidAt', args: [firstSpender] }),
          publicClient.readContract({ address: ra, abi: adapterAdminAbi, functionName: 'pendingTargetValidAt', args: [firstTarget] }),
          publicClient.readContract({ address: ra, abi: adapterAdminAbi, functionName: 'pendingSpenderValidAt', args: [firstSpender] }),
        ]);
        const trustChecks = await Promise.all([
          ...targets.map((t) => publicClient.readContract({ address: ea, abi: adapterAdminAbi, functionName: 'allowedTarget', args: [t] })),
          ...spenders.map((s) => publicClient.readContract({ address: ea, abi: adapterAdminAbi, functionName: 'allowedSpender', args: [s] })),
          ...targets.map((t) => publicClient.readContract({ address: ra, abi: adapterAdminAbi, functionName: 'allowedTarget', args: [t] })),
          ...spenders.map((s) => publicClient.readContract({ address: ra, abi: adapterAdminAbi, functionName: 'allowedSpender', args: [s] })),
        ]);
        const split = targets.length + spenders.length;
        executionTrustActive = trustChecks.slice(0, split).every(Boolean);
        rebalanceTrustActive = trustChecks.slice(split).every(Boolean);
      }

      setTrustStatus({ executionTargetAt, executionSpenderAt, rebalanceTargetAt, rebalanceSpenderAt, executionTrustActive, rebalanceTrustActive, executionCoreAt, rebalanceCoreAt, executionCoreActive, rebalanceCoreActive });
      setNotice('On-chain adapter and router status refreshed.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Status refresh failed.'); }
    finally { setBusy(''); }
  }

  async function writeOne(contract: `0x${string}`, abi: any, functionName: string, args: readonly unknown[], label: string) {
    if (!publicClient || !walletClient || !address) throw new Error('Wallet unavailable.');
    const gas = await publicClient.estimateContractGas({ account: address, address: contract, abi, functionName: functionName as any, args: args as any });
    const hash = await walletClient.writeContract({ account: address, chain: base, address: contract, abi, functionName: functionName as any, args: args as any, gas: (gas * 120n) / 100n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error(`${label} reverted.`);
    setNotice(`${label} confirmed: ${hash}`);
  }

  async function proposeTrust() {
    setError(''); setBusy('propose-trust');
    try {
      await ensureBaseAndOwner();
      if (!bothVerified || !saved.executionAdapter || !saved.rebalanceAdapter) throw new Error('Both adapters must be deployed and verified first.');
      const targets = parseAddressList(targetsText);
      const spenders = parseAddressList(spendersText);
      if (!targets.length || !spenders.length) throw new Error('Enter at least one verified swap target and one verified approval spender.');
      if (!publicClient) throw new Error('Base RPC unavailable.');

      for (const candidate of [...targets, ...spenders]) {
        const code = await publicClient.getBytecode({ address: candidate });
        if (!code || code === '0x') throw new Error(`No contract bytecode at ${candidate}. Do not allowlist it.`);
      }
      persist({ ...saved, targets: targetsText, spenders: spendersText });
      const adapters = [saved.executionAdapter, saved.rebalanceAdapter] as const;
      for (const adapter of adapters) {
        for (const target of targets) {
          const [allowed, pendingAt] = await Promise.all([
            publicClient.readContract({ address: adapter, abi: adapterAdminAbi, functionName: 'allowedTarget', args: [target] }),
            publicClient.readContract({ address: adapter, abi: adapterAdminAbi, functionName: 'pendingTargetValidAt', args: [target] }),
          ]);
          if (!allowed && pendingAt === 0n) await writeOne(adapter, adapterAdminAbi, 'proposeTarget', [target], `Propose target ${short(target)} on ${short(adapter)}`);
        }
        for (const spender of spenders) {
          const [allowed, pendingAt] = await Promise.all([
            publicClient.readContract({ address: adapter, abi: adapterAdminAbi, functionName: 'allowedSpender', args: [spender] }),
            publicClient.readContract({ address: adapter, abi: adapterAdminAbi, functionName: 'pendingSpenderValidAt', args: [spender] }),
          ]);
          if (!allowed && pendingAt === 0n) await writeOne(adapter, adapterAdminAbi, 'proposeSpender', [spender], `Propose spender ${short(spender)} on ${short(adapter)}`);
        }
      }
      await refreshStatus();
      setNotice('Adapter trust proposals confirmed. Wait the 1-day TRUST_DELAY before activation.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Trust proposal failed.'); }
    finally { setBusy(''); }
  }

  async function activateTrust() {
    setError(''); setBusy('activate-trust');
    try {
      await ensureBaseAndOwner();
      if (!saved.executionAdapter || !saved.rebalanceAdapter) throw new Error('Adapters missing.');
      const targets = parseAddressList(targetsText);
      const spenders = parseAddressList(spendersText);
      const adapters = [saved.executionAdapter, saved.rebalanceAdapter] as const;
      for (const adapter of adapters) {
        for (const target of targets) {
          const allowed = await publicClient!.readContract({ address: adapter, abi: adapterAdminAbi, functionName: 'allowedTarget', args: [target] });
          if (!allowed) await writeOne(adapter, adapterAdminAbi, 'activateTarget', [target], `Activate target ${short(target)} on ${short(adapter)}`);
        }
        for (const spender of spenders) {
          const allowed = await publicClient!.readContract({ address: adapter, abi: adapterAdminAbi, functionName: 'allowedSpender', args: [spender] });
          if (!allowed) await writeOne(adapter, adapterAdminAbi, 'activateSpender', [spender], `Activate spender ${short(spender)} on ${short(adapter)}`);
        }
      }
      await refreshStatus();
      setNotice('Adapter target/spender trust is active.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Trust activation failed.'); }
    finally { setBusy(''); }
  }

  async function proposeCoreAdapters() {
    setError(''); setBusy('propose-core');
    try {
      await ensureBaseAndOwner();
      if (!saved.executionAdapter || !saved.rebalanceAdapter) throw new Error('Adapters missing.');
      const [execApproved, execAt, rebApproved, rebAt] = await Promise.all([
        publicClient!.readContract({ address: EXECUTION_ROUTER, abi: routerAbi, functionName: 'approvedAdapter', args: [saved.executionAdapter] }),
        publicClient!.readContract({ address: EXECUTION_ROUTER, abi: routerAbi, functionName: 'adapterValidAt', args: [saved.executionAdapter] }),
        publicClient!.readContract({ address: REBALANCE_ROUTER, abi: routerAbi, functionName: 'approvedAdapter', args: [saved.rebalanceAdapter] }),
        publicClient!.readContract({ address: REBALANCE_ROUTER, abi: routerAbi, functionName: 'adapterValidAt', args: [saved.rebalanceAdapter] }),
      ]);
      if (!execApproved && execAt === 0n) await writeOne(EXECUTION_ROUTER, routerAbi, 'proposeAdapter', [saved.executionAdapter], 'Propose Execution Adapter on Execution Router');
      if (!rebApproved && rebAt === 0n) await writeOne(REBALANCE_ROUTER, routerAbi, 'proposeAdapter', [saved.rebalanceAdapter], 'Propose Rebalance Adapter on Rebalance Router');
      await refreshStatus();
      setNotice('Core router adapter proposals confirmed. Wait the routers’ 1-day ADAPTER_DELAY before activation.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Core adapter proposal failed.'); }
    finally { setBusy(''); }
  }

  async function activateCoreAdapters() {
    setError(''); setBusy('activate-core');
    try {
      await ensureBaseAndOwner();
      if (!saved.executionAdapter || !saved.rebalanceAdapter) throw new Error('Adapters missing.');
      const [execApproved, rebApproved] = await Promise.all([
        publicClient!.readContract({ address: EXECUTION_ROUTER, abi: routerAbi, functionName: 'approvedAdapter', args: [saved.executionAdapter] }),
        publicClient!.readContract({ address: REBALANCE_ROUTER, abi: routerAbi, functionName: 'approvedAdapter', args: [saved.rebalanceAdapter] }),
      ]);
      if (!execApproved) await writeOne(EXECUTION_ROUTER, routerAbi, 'activateAdapter', [saved.executionAdapter], 'Activate Execution Adapter');
      if (!rebApproved) await writeOne(REBALANCE_ROUTER, routerAbi, 'activateAdapter', [saved.rebalanceAdapter], 'Activate Rebalance Adapter');
      await refreshStatus();
      setNotice('Both restricted adapters are active on their core routers.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Core adapter activation failed.'); }
    finally { setBusy(''); }
  }

  const buttonStyle = { padding: '12px 16px', borderRadius: 10, border: '1px solid #404854', cursor: 'pointer', fontWeight: 700 } as const;
  const cardStyle = { border: '1px solid #2c3440', borderRadius: 16, padding: 18, marginBottom: 16, background: '#0d1117' } as const;
  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' as const };

  return (
    <main style={{ maxWidth: 920, margin: '0 auto', padding: '28px 18px 80px', color: '#f3f4f6' }}>
      <h1 style={{ fontSize: 32, marginBottom: 6 }}>Indexio V2.4.1 Restricted Adapter Deployment</h1>
      <p style={{ color: '#aab2bf', lineHeight: 1.6 }}>
        Base mainnet only. Wallet-signed. No private key is stored in Vercel. This deploys exactly two new adapter contracts and does not redeploy the V2.4 core.
      </p>

      <section style={cardStyle}>
        <h2>Connection</h2>
        <div>Network: Base mainnet · chain ID 8453</div>
        <div style={mono}>Required owner: {PROTOCOL_OWNER}</div>
        <div style={{ marginTop: 10 }}>
          {!isConnected ? (
            <button style={buttonStyle} disabled={connectPending} onClick={() => connect({ connector: connectors[0] })}>Connect wallet</button>
          ) : (
            <>
              <div style={mono}>Connected: {address}</div>
              <div style={{ color: isOwnerWallet ? '#79d99a' : '#ff9b8e', margin: '6px 0 10px' }}>{isOwnerWallet ? 'Protocol owner wallet confirmed.' : 'Wrong wallet for governance/deployment flow.'}</div>
              <button style={buttonStyle} onClick={() => disconnect()}>Disconnect</button>
            </>
          )}
        </div>
      </section>

      <section style={cardStyle}>
        <h2>Immutable core bindings</h2>
        <p>These are the already-deployed V2.4 routers. They are not redeployed.</p>
        <div style={mono}>Execution Router: {EXECUTION_ROUTER}</div>
        <div style={mono}>Rebalance Router: {REBALANCE_ROUTER}</div>
        <p style={{ color: '#aab2bf' }}>Adapter bytecode: {indexioRestrictedSwapAdapterCreationBytes.toLocaleString()} init bytes · {indexioRestrictedSwapAdapterRuntimeBytes.toLocaleString()} runtime bytes.</p>
      </section>

      {(['execution', 'rebalance'] as AdapterKind[]).map((kind, i) => {
        const adapter = kind === 'execution' ? saved.executionAdapter : saved.rebalanceAdapter;
        const verified = kind === 'execution' ? saved.executionVerified : saved.rebalanceVerified;
        const locked = kind === 'rebalance' && (!saved.executionAdapter || !saved.executionVerified);
        return (
          <section key={kind} style={cardStyle}>
            <h2>{i + 1}. {kind === 'execution' ? 'Execution' : 'Rebalance'} Restricted Swap Adapter</h2>
            <div>Bound permanently to: <span style={mono}>{kind === 'execution' ? EXECUTION_ROUTER : REBALANCE_ROUTER}</span></div>
            {adapter ? <div style={{ ...mono, marginTop: 8 }}>Deployed: <a style={{ color: '#7ab7ff' }} href={`${EXPLORER}/address/${adapter}`} target="_blank">{adapter}</a></div> : null}
            <div style={{ margin: '10px 0', color: verified ? '#79d99a' : '#f6c177' }}>Verification: {verified ? 'VERIFIED' : verify[kind].toUpperCase()}</div>
            {!adapter ? (
              <button style={buttonStyle} disabled={!!busy || locked || !isOwnerWallet} onClick={() => deployAdapter(kind)}>{locked ? 'Locked until Execution Adapter is verified' : `Deploy ${kind === 'execution' ? 'Execution' : 'Rebalance'} Adapter`}</button>
            ) : !verified ? (
              <button style={buttonStyle} disabled={!!busy} onClick={() => retryVerification(kind)}>Retry / check verification</button>
            ) : <strong style={{ color: '#79d99a' }}>Deployment complete.</strong>}
          </section>
        );
      })}

      <section style={cardStyle}>
        <h2>3. Configure adapter trust</h2>
        <p style={{ color: '#aab2bf' }}>Enter only verified production swap execution targets and approval spenders. Nothing is allowlisted automatically.</p>
        <label>Swap target contract(s)</label>
        <textarea value={targetsText} onChange={(e) => setTargetsText(e.target.value)} rows={3} placeholder="0x... one per line or comma-separated" style={{ width: '100%', margin: '6px 0 12px', padding: 12, borderRadius: 8, background: '#070a0f', color: '#fff' }} />
        <label>Approval spender contract(s)</label>
        <textarea value={spendersText} onChange={(e) => setSpendersText(e.target.value)} rows={3} placeholder="0x... one per line or comma-separated" style={{ width: '100%', margin: '6px 0 12px', padding: 12, borderRadius: 8, background: '#070a0f', color: '#fff' }} />
        <p>Proposal transaction count = 2 adapters × (targets + spenders). Each grant has a 1-day delay. Revocation remains immediate in the contract.</p>
        <button style={buttonStyle} disabled={!!busy || !bothVerified || !isOwnerWallet} onClick={proposeTrust}>Propose target + spender trust</button>{' '}
        <button style={buttonStyle} disabled={!!busy || !bothVerified || !isOwnerWallet} onClick={activateTrust}>Activate target + spender trust after 1 day</button>{' '}
        <button style={buttonStyle} disabled={!!busy || !bothDeployed} onClick={refreshStatus}>Refresh on-chain status</button>
        <div style={{ marginTop: 12, color: '#aab2bf' }}>
          <div>Execution target valid at: {fmtTime(trustStatus.executionTargetAt)}</div>
          <div>Execution spender valid at: {fmtTime(trustStatus.executionSpenderAt)}</div>
          <div>Rebalance target valid at: {fmtTime(trustStatus.rebalanceTargetAt)}</div>
          <div>Rebalance spender valid at: {fmtTime(trustStatus.rebalanceSpenderAt)}</div>
          <div>Execution trust active: {String(!!trustStatus.executionTrustActive)}</div>
          <div>Rebalance trust active: {String(!!trustStatus.rebalanceTrustActive)}</div>
        </div>
      </section>

      <section style={cardStyle}>
        <h2>4. Propose adapters on the existing core routers</h2>
        <p>This does not redeploy either router. It starts each router's existing 1-day ADAPTER_DELAY.</p>
        <button style={buttonStyle} disabled={!!busy || !trustStatus.executionTrustActive || !trustStatus.rebalanceTrustActive || !isOwnerWallet} onClick={proposeCoreAdapters}>Propose both adapters on core routers</button>
        <div style={{ marginTop: 12, color: '#aab2bf' }}>
          <div>Execution core valid at: {fmtTime(trustStatus.executionCoreAt)}</div>
          <div>Rebalance core valid at: {fmtTime(trustStatus.rebalanceCoreAt)}</div>
        </div>
      </section>

      <section style={cardStyle}>
        <h2>5. Activate adapters on the core routers</h2>
        <p>Run this only after both core-router valid-at timestamps have passed.</p>
        <button style={buttonStyle} disabled={!!busy || !isOwnerWallet} onClick={activateCoreAdapters}>Activate both core adapters</button>
        <div style={{ marginTop: 12 }}>
          <div>Execution Router approvedAdapter: <strong>{String(!!trustStatus.executionCoreActive)}</strong></div>
          <div>Rebalance Router approvedAdapter: <strong>{String(!!trustStatus.rebalanceCoreActive)}</strong></div>
        </div>
      </section>

      {notice ? <div style={{ ...cardStyle, borderColor: '#315f45', color: '#a9efc4' }}>{notice}</div> : null}
      {error ? <div style={{ ...cardStyle, borderColor: '#7f3030', color: '#ffb0aa' }}>{error}</div> : null}

      <section style={cardStyle}>
        <h2>Copy / paste final addresses</h2>
        <pre style={{ whiteSpace: 'pre-wrap', ...mono }}>{`NETWORK=base\nCHAIN_ID=8453\n\nINDEXIO_EXECUTION_ROUTER=${EXECUTION_ROUTER}\nINDEXIO_REBALANCE_ROUTER=${REBALANCE_ROUTER}\nNEXT_PUBLIC_INDEXIO_EXECUTION_ADAPTER=${summary.executionAdapter}\nNEXT_PUBLIC_INDEXIO_REBALANCE_ADAPTER=${summary.rebalanceAdapter}\n\nPROTOCOL_OWNER=${PROTOCOL_OWNER}`}</pre>
      </section>
    </main>
  );
}
