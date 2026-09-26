'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  getAddress,
  getContractAddress,
  isAddress,
  keccak256,
  stringToHex,
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
  indexioAssetRegistryAbi,
  indexioAssetRegistryBytecode,
  indexioAssetRegistryCreationBytes,
  indexioAssetRegistryRuntimeBytes,
  indexioVaultDeployerAbi,
  indexioVaultDeployerBytecode,
  indexioVaultDeployerCreationBytes,
  indexioVaultDeployerRuntimeBytes,
  indexioFactoryAbi,
  indexioFactoryBytecode,
  indexioFactoryCreationBytes,
  indexioFactoryRuntimeBytes,
  indexioExecutionRouterAbi,
  indexioExecutionRouterBytecode,
  indexioExecutionRouterCreationBytes,
  indexioExecutionRouterRuntimeBytes,
  indexioRebalanceRouterAbi,
  indexioRebalanceRouterBytecode,
  indexioRebalanceRouterCreationBytes,
  indexioRebalanceRouterRuntimeBytes,
  indexioCompilerVersion,
} from '../lib/indexio.generated';

const BASE_USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const STORAGE_KEY = 'indexio-v2.4:base-mainnet:deployment';
const EXPLORER = 'https://base.blockscout.com';

type Kind = 'registry' | 'vaultDeployer' | 'factory' | 'executionRouter' | 'rebalanceRouter';
type VerifyStatus = 'idle' | 'submitting' | 'pending' | 'verified' | 'error';
type AddressState = Partial<Record<Kind, `0x${string}`>>;
type HashState = Partial<Record<Kind, `0x${string}`>>;
type VerifyState = Record<Kind, VerifyStatus>;
type PreflightResult = { status: 'idle' | 'checking' | 'pass' | 'fail'; message?: string; gas?: string; gasLimit?: string; maxCostEth?: string; creationBytes?: number; runtimeBytes?: number };
type PreflightState = Record<Kind, PreflightResult>;

type SavedState = {
  owner?: string;
  treasury?: string;
  addresses?: Record<string, string>;
  hashes?: Record<string, string>;
  verified?: Record<string, boolean>;
  executionValidAt?: string;
  rebalanceValidAt?: string;
  executionActive?: boolean;
  rebalanceActive?: boolean;
};

const EMPTY_VERIFY: VerifyState = {
  registry: 'idle',
  vaultDeployer: 'idle',
  factory: 'idle',
  executionRouter: 'idle',
  rebalanceRouter: 'idle',
};

const LABELS: Record<Kind, string> = {
  registry: 'IndexioAssetRegistry',
  vaultDeployer: 'IndexioVaultDeployer',
  factory: 'IndexioFactory',
  executionRouter: 'IndexioExecutionRouter',
  rebalanceRouter: 'IndexioRebalanceRouter',
};

const DEPLOY_ORDER: Kind[] = ['registry', 'vaultDeployer', 'factory', 'executionRouter', 'rebalanceRouter'];
const EIP170_RUNTIME_LIMIT = 24_576;
const EIP3860_INITCODE_LIMIT = 49_152;
const VAULT_DEPLOYER_ID = keccak256(stringToHex('INDEXIO_VAULT_DEPLOYER_V2_4'));
const EMPTY_PREFLIGHT: PreflightState = Object.fromEntries(
  DEPLOY_ORDER.map((kind) => [kind, { status: 'idle' }]),
) as PreflightState;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function explorerAddress(address: string) {
  return `${EXPLORER}/address/${address}`;
}
function explorerTx(hash: string) {
  return `${EXPLORER}/tx/${hash}`;
}
function unixToText(value?: string) {
  if (!value || value === '0') return 'Not proposed';
  return new Date(Number(value) * 1000).toLocaleString();
}

export function IndexioDeployer() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync, reset: resetConnect } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: base.id });
  const { data: walletClient } = useWalletClient({ chainId: base.id });
  const injected = useMemo(() => connectors.find((x) => x.id === 'injected'), [connectors]);

  const [ownerInput, setOwnerInput] = useState('');
  const [treasuryInput, setTreasuryInput] = useState('');
  const [addresses, setAddresses] = useState<AddressState>({});
  const [hashes, setHashes] = useState<HashState>({});
  const [verify, setVerify] = useState<VerifyState>(EMPTY_VERIFY);
  const [verifyMessage, setVerifyMessage] = useState<Partial<Record<Kind, string>>>({});
  const [preflight, setPreflight] = useState<PreflightState>(EMPTY_PREFLIGHT);
  const [busy, setBusy] = useState<string | null>(null);
  const [mainnetAccepted, setMainnetAccepted] = useState(false);
  const [executionValidAt, setExecutionValidAt] = useState<string>();
  const [rebalanceValidAt, setRebalanceValidAt] = useState<string>();
  const [executionActive, setExecutionActive] = useState(false);
  const [rebalanceActive, setRebalanceActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recoveryInput, setRecoveryInput] = useState<Partial<Record<Kind, string>>>({});
  const autoRecoveryAttempted = useRef<Partial<Record<Kind, boolean>>>({});

  const onBase = chainId === base.id;
  const owner = isAddress(ownerInput) ? getAddress(ownerInput) : null;
  const treasury = isAddress(treasuryInput) ? getAddress(treasuryInput) : null;
  const ownerConnected = !!address && !!owner && address.toLowerCase() === owner.toLowerCase();
  const allVerified = DEPLOY_ORDER.every((kind) => verify[kind] === 'verified');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as SavedState;
      if (saved.owner && isAddress(saved.owner)) setOwnerInput(getAddress(saved.owner));
      if (saved.treasury && isAddress(saved.treasury)) setTreasuryInput(getAddress(saved.treasury));
      const nextAddresses: AddressState = {};
      for (const kind of Object.keys(LABELS) as Kind[]) {
        const value = saved.addresses?.[kind];
        if (value && isAddress(value)) nextAddresses[kind] = getAddress(value);
      }
      setAddresses(nextAddresses);
      const nextHashes: HashState = {};
      for (const kind of Object.keys(LABELS) as Kind[]) {
        const value = saved.hashes?.[kind];
        if (value && /^0x[0-9a-fA-F]{64}$/.test(value)) nextHashes[kind] = value as `0x${string}`;
      }
      setHashes(nextHashes);
      setVerify({
        registry: saved.verified?.registry ? 'verified' : 'idle',
        vaultDeployer: saved.verified?.vaultDeployer ? 'verified' : 'idle',
        factory: saved.verified?.factory ? 'verified' : 'idle',
        executionRouter: saved.verified?.executionRouter ? 'verified' : 'idle',
        rebalanceRouter: saved.verified?.rebalanceRouter ? 'verified' : 'idle',
      });
      setExecutionValidAt(saved.executionValidAt);
      setRebalanceValidAt(saved.rebalanceValidAt);
      setExecutionActive(!!saved.executionActive);
      setRebalanceActive(!!saved.rebalanceActive);
    } catch {
      // Ignore malformed browser state. On-chain validation still gates every action.
    }
  }, []);

  useEffect(() => {
    if (!address) return;
    if (!ownerInput) setOwnerInput(address);
    if (!treasuryInput) setTreasuryInput(address);
  }, [address, ownerInput, treasuryInput]);

  useEffect(() => {
    try {
      const saved: SavedState = {
        owner: ownerInput,
        treasury: treasuryInput,
        addresses,
        hashes,
        verified: Object.fromEntries(Object.entries(verify).map(([k, v]) => [k, v === 'verified'])),
        executionValidAt,
        rebalanceValidAt,
        executionActive,
        rebalanceActive,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      // Browser persistence is convenience only.
    }
  }, [ownerInput, treasuryInput, addresses, hashes, verify, executionValidAt, rebalanceValidAt, executionActive, rebalanceActive]);

  async function connectWallet() {
    setError(null);
    if (!injected) return setError('No injected wallet was detected.');
    setBusy('connect');
    resetConnect();
    try {
      await connectAsync({ connector: injected, chainId: base.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Wallet connection failed.');
    } finally {
      setBusy(null);
    }
  }

  function requireReady() {
    if (!address || !isConnected) throw new Error('Connect the deployment wallet first.');
    if (!onBase) throw new Error('Switch the wallet to Base mainnet first.');
    if (!walletClient || !publicClient) throw new Error('Base wallet client is not ready yet.');
    if (!owner || !treasury) throw new Error('Enter valid Protocol Owner and Fee Treasury addresses.');
    if (!ownerConnected) throw new Error(`For this sequential governance flow, connect the Protocol Owner wallet ${owner}.`);
    if (!mainnetAccepted) throw new Error('Confirm the Base mainnet deployment acknowledgement first.');
    return { account: address, owner, treasury };
  }

  function constructorArgs(kind: Kind) {
    if (!owner || !treasury) throw new Error('Owner and treasury must be valid first.');
    if (kind === 'registry') return [owner] as const;
    if (kind === 'vaultDeployer') return [] as const;
    if (kind === 'factory') {
      if (!addresses.registry) throw new Error('Deploy and verify Asset Registry first.');
      if (!addresses.vaultDeployer) throw new Error('Deploy and verify Vault Deployer first.');
      return [owner, addresses.registry, BASE_USDC, treasury, addresses.vaultDeployer] as const;
    }
    if (kind === 'executionRouter') {
      if (!addresses.factory) throw new Error('Deploy and verify Factory first.');
      return [owner, addresses.factory, BASE_USDC] as const;
    }
    if (!addresses.factory) throw new Error('Deploy and verify Factory first.');
    return [owner, addresses.factory] as const;
  }

  function artifact(kind: Kind) {
    if (kind === 'registry') return { abi: indexioAssetRegistryAbi, bytecode: indexioAssetRegistryBytecode, creationBytes: indexioAssetRegistryCreationBytes, runtimeBytes: indexioAssetRegistryRuntimeBytes };
    if (kind === 'vaultDeployer') return { abi: indexioVaultDeployerAbi, bytecode: indexioVaultDeployerBytecode, creationBytes: indexioVaultDeployerCreationBytes, runtimeBytes: indexioVaultDeployerRuntimeBytes };
    if (kind === 'factory') return { abi: indexioFactoryAbi, bytecode: indexioFactoryBytecode, creationBytes: indexioFactoryCreationBytes, runtimeBytes: indexioFactoryRuntimeBytes };
    if (kind === 'executionRouter') return { abi: indexioExecutionRouterAbi, bytecode: indexioExecutionRouterBytecode, creationBytes: indexioExecutionRouterCreationBytes, runtimeBytes: indexioExecutionRouterRuntimeBytes };
    return { abi: indexioRebalanceRouterAbi, bytecode: indexioRebalanceRouterBytecode, creationBytes: indexioRebalanceRouterCreationBytes, runtimeBytes: indexioRebalanceRouterRuntimeBytes };
  }

  function encodedConstructor(kind: Kind) {
    const args = constructorArgs(kind);
    if (kind === 'vaultDeployer') return '0x' as const;
    if (kind === 'registry') return encodeAbiParameters([{ type: 'address' }], args as readonly [`0x${string}`]);
    if (kind === 'factory') return encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }],
      args as readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`],
    );
    if (kind === 'executionRouter') return encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
      args as readonly [`0x${string}`, `0x${string}`, `0x${string}`],
    );
    return encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }],
      args as readonly [`0x${string}`, `0x${string}`],
    );
  }

  async function validate(kind: Kind, target: `0x${string}`) {
    if (!publicClient || !owner || !treasury) throw new Error('Validation client not ready.');
    const read = (abi: readonly unknown[], functionName: string) => publicClient.readContract({
      address: target,
      abi: abi as any,
      functionName: functionName as any,
    });

    if (kind === 'registry') {
      const contractOwner = await read(indexioAssetRegistryAbi, 'owner');
      if (String(contractOwner).toLowerCase() !== owner.toLowerCase()) throw new Error('Asset Registry owner validation failed.');
      return;
    }
    if (kind === 'vaultDeployer') {
      const deployerId = await read(indexioVaultDeployerAbi, 'DEPLOYER_ID');
      if (String(deployerId).toLowerCase() !== VAULT_DEPLOYER_ID.toLowerCase()) throw new Error('Vault Deployer identity validation failed.');
      return;
    }
    if (kind === 'factory') {
      const [contractOwner, registry, settlement, feeTreasury, vaultDeployer] = await Promise.all([
        read(indexioFactoryAbi, 'owner'), read(indexioFactoryAbi, 'registry'),
        read(indexioFactoryAbi, 'settlementToken'), read(indexioFactoryAbi, 'feeTreasury'), read(indexioFactoryAbi, 'vaultDeployer'),
      ]);
      if (String(contractOwner).toLowerCase() !== owner.toLowerCase()) throw new Error('Factory owner validation failed.');
      if (String(registry).toLowerCase() !== addresses.registry?.toLowerCase()) throw new Error('Factory registry validation failed.');
      if (String(settlement).toLowerCase() !== BASE_USDC.toLowerCase()) throw new Error('Factory settlement token validation failed.');
      if (String(feeTreasury).toLowerCase() !== treasury.toLowerCase()) throw new Error('Factory fee treasury validation failed.');
      if (String(vaultDeployer).toLowerCase() !== addresses.vaultDeployer?.toLowerCase()) throw new Error('Factory vault deployer validation failed.');
      return;
    }
    if (kind === 'executionRouter') {
      const [contractOwner, factory, settlement] = await Promise.all([
        read(indexioExecutionRouterAbi, 'owner'), read(indexioExecutionRouterAbi, 'factory'), read(indexioExecutionRouterAbi, 'settlementToken'),
      ]);
      if (String(contractOwner).toLowerCase() !== owner.toLowerCase()) throw new Error('Execution Router owner validation failed.');
      if (String(factory).toLowerCase() !== addresses.factory?.toLowerCase()) throw new Error('Execution Router factory validation failed.');
      if (String(settlement).toLowerCase() !== BASE_USDC.toLowerCase()) throw new Error('Execution Router settlement token validation failed.');
      return;
    }
    const [contractOwner, factory] = await Promise.all([
      read(indexioRebalanceRouterAbi, 'owner'), read(indexioRebalanceRouterAbi, 'factory'),
    ]);
    if (String(contractOwner).toLowerCase() !== owner.toLowerCase()) throw new Error('Rebalance Router owner validation failed.');
    if (String(factory).toLowerCase() !== addresses.factory?.toLowerCase()) throw new Error('Rebalance Router factory validation failed.');
  }

  async function constructorArgumentsForVerification(kind: Kind, target: `0x${string}`) {
    if (!publicClient) throw new Error('Base RPC client is not ready.');
    if (kind === 'vaultDeployer') return '';
    if (kind === 'registry') {
      const deployedOwner = getAddress(String(await publicClient.readContract({ address: target, abi: indexioAssetRegistryAbi, functionName: 'owner' })));
      return encodeAbiParameters([{ type: 'address' }], [deployedOwner]).slice(2);
    }
    if (kind === 'factory') {
      const [deployedOwner, registry, settlement, feeTreasury, vaultDeployer] = await Promise.all([
        publicClient.readContract({ address: target, abi: indexioFactoryAbi, functionName: 'owner' }),
        publicClient.readContract({ address: target, abi: indexioFactoryAbi, functionName: 'registry' }),
        publicClient.readContract({ address: target, abi: indexioFactoryAbi, functionName: 'settlementToken' }),
        publicClient.readContract({ address: target, abi: indexioFactoryAbi, functionName: 'feeTreasury' }),
        publicClient.readContract({ address: target, abi: indexioFactoryAbi, functionName: 'vaultDeployer' }),
      ]);
      return encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }],
        [getAddress(String(deployedOwner)), getAddress(String(registry)), getAddress(String(settlement)), getAddress(String(feeTreasury)), getAddress(String(vaultDeployer))],
      ).slice(2);
    }
    if (kind === 'executionRouter') {
      const [deployedOwner, factory, settlement] = await Promise.all([
        publicClient.readContract({ address: target, abi: indexioExecutionRouterAbi, functionName: 'owner' }),
        publicClient.readContract({ address: target, abi: indexioExecutionRouterAbi, functionName: 'factory' }),
        publicClient.readContract({ address: target, abi: indexioExecutionRouterAbi, functionName: 'settlementToken' }),
      ]);
      return encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
        [getAddress(String(deployedOwner)), getAddress(String(factory)), getAddress(String(settlement))],
      ).slice(2);
    }
    const [deployedOwner, factory] = await Promise.all([
      publicClient.readContract({ address: target, abi: indexioRebalanceRouterAbi, functionName: 'owner' }),
      publicClient.readContract({ address: target, abi: indexioRebalanceRouterAbi, functionName: 'factory' }),
    ]);
    return encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [getAddress(String(deployedOwner)), getAddress(String(factory))]).slice(2);
  }

  async function runDeploymentPreflight(kind: Kind, showNotice = true) {
    const { account } = requireReady();
    const { abi, bytecode, runtimeBytes } = artifact(kind);
    const args = constructorArgs(kind);
    const data = encodeDeployData({ abi: abi as any, bytecode, args: args as any });
    const initCodeBytes = (data.length - 2) / 2;

    setPreflight((x) => ({ ...x, [kind]: { status: 'checking', creationBytes: initCodeBytes, runtimeBytes } }));

    if (initCodeBytes > EIP3860_INITCODE_LIMIT) {
      const message = `${LABELS[kind]} init code is ${initCodeBytes.toLocaleString()} bytes, above the EVM ${EIP3860_INITCODE_LIMIT.toLocaleString()}-byte init-code limit.`;
      setPreflight((x) => ({ ...x, [kind]: { status: 'fail', message, creationBytes: initCodeBytes, runtimeBytes } }));
      throw new Error(`Preflight FAIL: ${message}`);
    }
    if (runtimeBytes > EIP170_RUNTIME_LIMIT) {
      const message = `${LABELS[kind]} runtime is ${runtimeBytes.toLocaleString()} bytes, above the EVM ${EIP170_RUNTIME_LIMIT.toLocaleString()}-byte deployed-code limit.`;
      setPreflight((x) => ({ ...x, [kind]: { status: 'fail', message, creationBytes: initCodeBytes, runtimeBytes } }));
      throw new Error(`Preflight FAIL: ${message}`);
    }

    try {
      const [gas, gasPrice] = await Promise.all([
        publicClient!.estimateGas({ account, data }),
        publicClient!.getGasPrice(),
      ]);
      const gasLimit = (gas * 120n + 99n) / 100n;
      const maxCostEth = formatEther(gasLimit * gasPrice);
      const result: PreflightResult = {
        status: 'pass',
        message: 'Base mainnet accepted the deployment simulation. The wallet transaction may now be opened safely.',
        gas: gas.toString(),
        gasLimit: gasLimit.toString(),
        maxCostEth,
        creationBytes: initCodeBytes,
        runtimeBytes,
      };
      setPreflight((x) => ({ ...x, [kind]: result }));
      if (showNotice) setNotice(`${LABELS[kind]} preflight PASS. Estimated gas ${gas.toLocaleString()}; buffered limit ${gasLimit.toLocaleString()}; current max gas estimate ≈ ${maxCostEth} ETH on Base.`);
      return { data, gas, gasLimit, initCodeBytes, runtimeBytes };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'Base RPC rejected the deployment simulation.';
      const message = `Base deployment simulation failed: ${detail}`;
      setPreflight((x) => ({ ...x, [kind]: { status: 'fail', message, creationBytes: initCodeBytes, runtimeBytes } }));
      throw new Error(`Preflight FAIL: ${message}`);
    }
  }

  async function checkDeploymentPreflight(kind: Kind) {
    setError(null); setNotice(null);
    try {
      setBusy(`preflight:${kind}`);
      await runDeploymentPreflight(kind, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${LABELS[kind]} preflight failed.`);
    } finally {
      setBusy(null);
    }
  }

  async function verifyContract(kind: Kind, mode: 'verify' | 'check' = 'verify') {
    const target = addresses[kind];
    if (!target) throw new Error(`Deploy ${LABELS[kind]} first.`);
    setVerify((v) => ({ ...v, [kind]: 'submitting' }));
    setVerifyMessage((m) => ({ ...m, [kind]: mode === 'check' ? 'Checking Blockscout…' : 'Submitting exact source to Blockscout…' }));
    try {
      const constructorArguments = await constructorArgumentsForVerification(kind, target);
      const res = await fetch('/api/blockscout/verify-indexio', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, address: target, constructorArguments, mode }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Blockscout verification failed.');
      setVerify((v) => ({ ...v, [kind]: json?.verified ? 'verified' : 'pending' }));
      setVerifyMessage((m) => ({ ...m, [kind]: json?.message || (json?.verified ? 'Verified.' : 'Verification pending.') }));
      return !!json?.verified;
    } catch (cause) {
      setVerify((v) => ({ ...v, [kind]: 'error' }));
      throw cause;
    }
  }


  function persistCoreDeployment(kind: Kind, deployed: `0x${string}`, hash?: `0x${string}`) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) as SavedState : {};
      const nextHashes = { ...(saved.hashes || {}) };
      if (hash) nextHashes[kind] = hash;
      const next: SavedState = {
        ...saved,
        owner: ownerInput,
        treasury: treasuryInput,
        addresses: { ...(saved.addresses || {}), [kind]: deployed },
        hashes: nextHashes,
        verified: { ...(saved.verified || {}), [kind]: false },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Best-effort recovery state only. On-chain validation remains authoritative.
    }
  }

  async function recoverExisting(kind: Kind, rawAddress?: string) {
    setError(null); setNotice(null);
    try {
      if (!publicClient) throw new Error('Base RPC client is not ready yet.');
      if (!owner || !treasury) throw new Error('Enter valid Protocol Owner and Fee Treasury addresses first.');
      const candidate = (rawAddress ?? recoveryInput[kind] ?? '').trim();
      if (!isAddress(candidate)) throw new Error(`Enter a valid existing ${LABELS[kind]} address.`);
      const target = getAddress(candidate);

      setBusy(`recover:${kind}`);
      const code = await publicClient.getBytecode({ address: target });
      if (!code || code === '0x') throw new Error(`No contract bytecode exists at ${target} on Base mainnet.`);

      await validate(kind, target);
      setAddresses((x) => ({ ...x, [kind]: target }));
      persistCoreDeployment(kind, target);
      setRecoveryInput((x) => ({ ...x, [kind]: target }));
      setVerify((v) => ({ ...v, [kind]: 'pending' }));
      setVerifyMessage((m) => ({ ...m, [kind]: 'Existing on-chain deployment recovered and validated. Submitting Blockscout verification now…' }));
      setNotice(`${LABELS[kind]} recovered at ${target}. No deployment transaction was sent.`);

      const verifiedNow = await submitAndPollVerification(kind, target);
      if (verifiedNow) setNotice(`${LABELS[kind]} recovered, validated and verified. The next contract is now unlocked.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${LABELS[kind]} recovery failed.`);
    } finally {
      setBusy(null);
    }
  }

  async function submitAndPollVerification(kind: Kind, deployed: `0x${string}`) {
    const constructorArguments = await constructorArgumentsForVerification(kind, deployed);
    setVerify((v) => ({ ...v, [kind]: 'submitting' }));
    setVerifyMessage((m) => ({ ...m, [kind]: 'Submitting exact source to Base Blockscout…' }));

    const submit = await fetch('/api/blockscout/verify-indexio', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, address: deployed, constructorArguments, mode: 'verify' }),
    });
    const submitted = await submit.json();
    if (!submit.ok) throw new Error(submitted?.error || `${LABELS[kind]} verification failed.`);
    if (submitted?.verified) {
      setVerify((v) => ({ ...v, [kind]: 'verified' }));
      setVerifyMessage((m) => ({ ...m, [kind]: submitted?.message || 'Verified on Base Blockscout.' }));
      return true;
    }

    setVerify((v) => ({ ...v, [kind]: 'pending' }));
    setVerifyMessage((m) => ({ ...m, [kind]: submitted?.message || 'Deployment is complete. Blockscout verification is pending; do not redeploy.' }));

    // Blockscout often needs a few seconds to index freshly-created bytecode.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(3000);
      const check = await fetch('/api/blockscout/verify-indexio', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, address: deployed, constructorArguments, mode: 'check' }),
      });
      const checked = await check.json();
      if (!check.ok) continue;
      if (checked?.verified) {
        setVerify((v) => ({ ...v, [kind]: 'verified' }));
        setVerifyMessage((m) => ({ ...m, [kind]: checked?.message || 'Verified on Base Blockscout.' }));
        return true;
      }
    }

    setVerify((v) => ({ ...v, [kind]: 'pending' }));
    setVerifyMessage((m) => ({ ...m, [kind]: 'Contract is deployed and saved. Blockscout is still indexing it. Do NOT redeploy; use Check verification.' }));
    return false;
  }

  useEffect(() => {
    if (!publicClient || !addresses.factory || !addresses.executionRouter || !addresses.rebalanceRouter) return;
    let cancelled = false;
    void (async () => {
      try {
        const [executionPending, rebalancePending, executionIsActive, rebalanceIsActive] = await Promise.all([
          publicClient.readContract({ address: addresses.factory!, abi: indexioFactoryAbi, functionName: 'pendingExecutionRouterValidAt', args: [addresses.executionRouter!] }),
          publicClient.readContract({ address: addresses.factory!, abi: indexioFactoryAbi, functionName: 'pendingRebalanceRouterValidAt', args: [addresses.rebalanceRouter!] }),
          publicClient.readContract({ address: addresses.factory!, abi: indexioFactoryAbi, functionName: 'isExecutionRouter', args: [addresses.executionRouter!] }),
          publicClient.readContract({ address: addresses.factory!, abi: indexioFactoryAbi, functionName: 'isRebalanceRouter', args: [addresses.rebalanceRouter!] }),
        ]);
        if (cancelled) return;
        const executionTs = String(executionPending);
        const rebalanceTs = String(rebalancePending);
        if (executionTs !== '0') setExecutionValidAt(executionTs);
        if (rebalanceTs !== '0') setRebalanceValidAt(rebalanceTs);
        setExecutionActive(Boolean(executionIsActive));
        setRebalanceActive(Boolean(rebalanceIsActive));
      } catch {
        // Browser state remains available; governance actions still preflight on-chain before signing.
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, addresses.factory, addresses.executionRouter, addresses.rebalanceRouter]);

  useEffect(() => {
    if (!publicClient || !owner || !treasury) return;
    for (const kind of Object.keys(LABELS) as Kind[]) {
      if (addresses[kind] || !hashes[kind] || autoRecoveryAttempted.current[kind]) continue;
      autoRecoveryAttempted.current[kind] = true;
      const hash = hashes[kind]!;
      void (async () => {
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash });
          if (receipt.status !== 'success' || !receipt.contractAddress) return;
          const target = getAddress(receipt.contractAddress);
          const code = await publicClient.getBytecode({ address: target });
          if (!code || code === '0x') return;
          await validate(kind, target);
          setAddresses((x) => ({ ...x, [kind]: target }));
          persistCoreDeployment(kind, target, hash);
          setVerify((v) => ({ ...v, [kind]: 'pending' }));
          setVerifyMessage((m) => ({ ...m, [kind]: 'Recovered automatically from the saved successful deployment transaction. Do not redeploy.' }));
          setNotice(`${LABELS[kind]} was recovered automatically from its deployment transaction at ${target}. No new transaction was sent.`);
        } catch {
          // Leave the manual recovery field available if the historical transaction cannot be resolved.
        }
      })();
    }
  }, [publicClient, owner, treasury, addresses, hashes]);

  async function deploy(kind: Kind) {
    setError(null); setNotice(null);
    try {
      const { account } = requireReady();
      if (addresses[kind]) throw new Error(`${LABELS[kind]} already has a saved deployment. Use the existing address; do not redeploy it.`);
      if (kind === 'vaultDeployer' && verify.registry !== 'verified') throw new Error('Asset Registry must be verified before Vault Deployer deployment.');
      if (kind === 'factory' && verify.vaultDeployer !== 'verified') throw new Error('Vault Deployer must be verified before Factory deployment.');
      if (kind === 'executionRouter' && verify.factory !== 'verified') throw new Error('Factory must be verified before Execution Router deployment.');
      if (kind === 'rebalanceRouter' && verify.executionRouter !== 'verified') throw new Error('Execution Router must be verified before Rebalance Router deployment.');

      setBusy(`deploy:${kind}`);
      const { data, gasLimit } = await runDeploymentPreflight(kind, false);
      const nonce = await publicClient!.getTransactionCount({ address: account, blockTag: 'pending' });
      const predicted = getContractAddress({ from: account, nonce: BigInt(nonce) });
      const hash = await walletClient!.sendTransaction({ account, chain: base, data, gas: gasLimit });
      setHashes((x) => ({ ...x, [kind]: hash }));
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`${LABELS[kind]} deployment reverted.`);
      const deployed = (receipt.contractAddress ?? predicted) as `0x${string}`;
      const code = await publicClient!.getBytecode({ address: deployed });
      if (!code || code === '0x') throw new Error(`${LABELS[kind]} bytecode was not found after deployment.`);
      await validate(kind, deployed);

      // Persist the successful deployment BEFORE any off-chain verification call.
      // A Blockscout delay/failure must never make the UI offer a duplicate deployment.
      setAddresses((x) => ({ ...x, [kind]: deployed }));
      persistCoreDeployment(kind, deployed, hash);
      setNotice(`${LABELS[kind]} deployed and validated at ${deployed}. Verification is off-chain; do not redeploy this contract.`);

      await sleep(1200);
      const verifiedNow = await submitAndPollVerification(kind, deployed);
      if (verifiedNow) setNotice(`${LABELS[kind]} deployed, validated and verified. The next contract is now unlocked.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${LABELS[kind]} deployment failed.`);
    } finally {
      setBusy(null);
    }
  }

  async function checkVerification(kind: Kind) {
    setError(null);
    try { await verifyContract(kind, 'check'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Verification check failed.'); }
  }

  async function retryVerification(kind: Kind) {
    setError(null);
    setNotice(null);
    const target = addresses[kind];
    if (!target) return setError(`Recover or deploy ${LABELS[kind]} first.`);
    setBusy(`verify:${kind}`);
    try {
      await validate(kind, target);
      const verifiedNow = await submitAndPollVerification(kind, target);
      if (verifiedNow) {
        setNotice(`${LABELS[kind]} is verified on Base Blockscout. The next contract is now unlocked.`);
      } else {
        setNotice(`${LABELS[kind]} remains deployed at ${target}. Verification was resubmitted off-chain; no deployment transaction was sent.`);
      }
    } catch (cause) {
      setVerify((v) => ({ ...v, [kind]: 'error' }));
      setError(cause instanceof Error ? cause.message : 'Verification retry failed.');
    } finally {
      setBusy(null);
    }
  }

  async function governanceTx(functionName: 'proposeExecutionRouter' | 'proposeRebalanceRouter' | 'activateExecutionRouter' | 'activateRebalanceRouter') {
    setError(null); setNotice(null);
    try {
      const { account } = requireReady();
      if (!addresses.factory || !addresses.executionRouter || !addresses.rebalanceRouter) throw new Error('Core contracts are incomplete.');
      if (!allVerified) throw new Error('All five core contracts must be verified before governance proposals.');

      const isExecution = functionName.includes('Execution');
      const target = isExecution ? addresses.executionRouter : addresses.rebalanceRouter;
      const isActivation = functionName.startsWith('activate');
      setBusy(functionName);

      if (isActivation) {
        const validAt = BigInt(isExecution ? (executionValidAt || '0') : (rebalanceValidAt || '0'));
        if (validAt === 0n) throw new Error(`${isExecution ? 'Execution' : 'Rebalance'} Router has not been proposed.`);
        const block = await publicClient!.getBlock();
        if (BigInt(block.timestamp) < validAt) throw new Error(`Governance timelock has not expired. Earliest activation: ${new Date(Number(validAt) * 1000).toLocaleString()}.`);
      }

      const data = encodeFunctionData({
        abi: indexioFactoryAbi,
        functionName: functionName as any,
        args: [target] as any,
      });
      let gasEstimate: bigint;
      try {
        gasEstimate = await publicClient!.estimateGas({ account, to: addresses.factory, data });
      } catch (cause) {
        throw new Error(`Governance preflight failed before opening the wallet: ${cause instanceof Error ? cause.message : 'Base RPC rejected the transaction.'}`);
      }
      const gasLimit = (gasEstimate * 120n + 99n) / 100n;
      const hash = await walletClient!.sendTransaction({ account, chain: base, to: addresses.factory, data, gas: gasLimit });
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`${functionName} reverted.`);

      if (functionName === 'proposeExecutionRouter') {
        const t = await publicClient!.readContract({ address: addresses.factory, abi: indexioFactoryAbi, functionName: 'pendingExecutionRouterValidAt', args: [addresses.executionRouter] });
        setExecutionValidAt(String(t));
        setNotice(`Execution Router proposal confirmed. Activation unlocks at ${new Date(Number(t) * 1000).toLocaleString()}.`);
      } else if (functionName === 'proposeRebalanceRouter') {
        const t = await publicClient!.readContract({ address: addresses.factory, abi: indexioFactoryAbi, functionName: 'pendingRebalanceRouterValidAt', args: [addresses.rebalanceRouter] });
        setRebalanceValidAt(String(t));
        setNotice(`Rebalance Router proposal confirmed. Activation unlocks at ${new Date(Number(t) * 1000).toLocaleString()}.`);
      } else if (functionName === 'activateExecutionRouter') {
        const active = await publicClient!.readContract({ address: addresses.factory, abi: indexioFactoryAbi, functionName: 'isExecutionRouter', args: [addresses.executionRouter] });
        if (!active) throw new Error('Execution Router activation validation failed.');
        setExecutionActive(true);
        setNotice('Execution Router is ACTIVE and validated on-chain.');
      } else {
        const active = await publicClient!.readContract({ address: addresses.factory, abi: indexioFactoryAbi, functionName: 'isRebalanceRouter', args: [addresses.rebalanceRouter] });
        if (!active) throw new Error('Rebalance Router activation validation failed.');
        setRebalanceActive(true);
        setNotice('Rebalance Router is ACTIVE and validated on-chain.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Governance transaction failed.');
    } finally {
      setBusy(null);
    }
  }

  function clearLocalState() {
    if (!confirm('Clear only this browser\'s saved Indexio deployment state? This does NOT change or delete anything on-chain.')) return;
    localStorage.removeItem(STORAGE_KEY);
    setAddresses({}); setHashes({}); setVerify(EMPTY_VERIFY); setVerifyMessage({}); setPreflight(EMPTY_PREFLIGHT);
    setExecutionValidAt(undefined); setRebalanceValidAt(undefined); setExecutionActive(false); setRebalanceActive(false);
    setNotice('Local browser state cleared. On-chain contracts were not touched.');
  }

  const copyBlock = [
    'NETWORK=base',
    'CHAIN_ID=8453',
    `SETTLEMENT_TOKEN=${BASE_USDC}`,
    `INDEXIO_ASSET_REGISTRY=${addresses.registry || ''}`,
    `INDEXIO_VAULT_DEPLOYER=${addresses.vaultDeployer || ''}`,
    `INDEXIO_FACTORY=${addresses.factory || ''}`,
    `INDEXIO_EXECUTION_ROUTER=${addresses.executionRouter || ''}`,
    `INDEXIO_REBALANCE_ROUTER=${addresses.rebalanceRouter || ''}`,
    `PROTOCOL_OWNER=${owner || ownerInput}`,
    `FEE_TREASURY=${treasury || treasuryInput}`,
  ].join('\n');

  const stage = (kind: Kind, step: string, intent: string, unlocked: boolean) => {
    const target = addresses[kind];
    const status = verify[kind];
    const pf = preflight[kind];
    return <section className="card stepCard" key={kind}>
      <div className="stepHead"><span className="stepNo">{step}</span><div><h2>{LABELS[kind]}</h2><p>{intent}</p></div></div>
      <div className="details">
        <div><span>Status</span><strong>{target ? (status === 'verified' ? 'DEPLOYED + VERIFIED' : `DEPLOYED · ${status.toUpperCase()}`) : 'NOT DEPLOYED'}</strong></div>
        <div><span>Compiler</span><code>{indexioCompilerVersion}</code></div>
        {target && <div><span>Address</span><code>{target}</code></div>}
        {hashes[kind] && <div><span>Deploy tx</span><a href={explorerTx(hashes[kind]!)} target="_blank" rel="noreferrer">Open transaction ↗</a></div>}
      </div>
      {!target && <>
        <div style={{ display: 'grid', gap: 10 }}>
          <button className="secondary" disabled={!unlocked || !!busy} onClick={() => checkDeploymentPreflight(kind)}>{busy === `preflight:${kind}` || pf.status === 'checking' ? 'Running Base preflight…' : 'Check deployment preflight'}</button>
          {pf.status !== 'idle' && <div className={`notice ${pf.status === 'pass' ? 'success' : pf.status === 'fail' ? 'danger' : ''}`}>
            <strong>Preflight: {pf.status.toUpperCase()}</strong>
            {typeof pf.creationBytes === 'number' && <> · Init code: {pf.creationBytes.toLocaleString()} bytes · Runtime: {(pf.runtimeBytes || 0).toLocaleString()} bytes</>}
            {pf.gas && <> · Estimated gas: {BigInt(pf.gas).toLocaleString()}</>}{pf.maxCostEth && <> · Max gas estimate: ≈ {pf.maxCostEth} ETH</>}
            {pf.message && <div style={{ marginTop: 6 }}>{pf.message}</div>}
          </div>}
          <button className="primary deploy" disabled={!unlocked || !!busy} onClick={() => deploy(kind)}>{busy === `deploy:${kind}` ? 'Preflighting + deploying…' : `Deploy + validate ${LABELS[kind]}`}</button>
        </div>
        <div className="notice strong" style={{ marginTop: 12 }}>
          <strong>Already deployed this contract?</strong> Recover the existing Base address instead of deploying again. Recovery is read-only until Blockscout verification and sends no deployment transaction.
          <label className="field" style={{ marginTop: 10 }}>EXISTING {LABELS[kind].toUpperCase()} ADDRESS
            <input value={recoveryInput[kind] || ''} onChange={(e) => setRecoveryInput((x) => ({ ...x, [kind]: e.target.value.trim() }))} placeholder="0x…" />
          </label>
          <button className="secondary" disabled={!!busy || !recoveryInput[kind]} onClick={() => recoverExisting(kind)}>{busy === `recover:${kind}` ? 'Recovering + validating…' : 'Use existing deployment'}</button>
        </div>
      </>}
      {target && status !== 'verified' && <div style={{ display: 'grid', gap: 10 }}>
        <button className="primary" disabled={!!busy || status === 'submitting'} onClick={() => retryVerification(kind)}>{busy === `verify:${kind}` || status === 'submitting' ? 'Submitting verification…' : 'Retry verification'}</button>
        <button className="secondary" disabled={!!busy || status === 'submitting'} onClick={() => checkVerification(kind)}>Check verification status</button>
      </div>}
      {target && <a className="linkButton" href={explorerAddress(target)} target="_blank" rel="noreferrer">Open contract on Base Blockscout ↗</a>}
      {target && status !== 'verified' && <div className="notice"><strong>Already deployed.</strong> Do not deploy this contract again. <strong>Retry verification</strong> only resubmits source code to Blockscout; it does not send a blockchain transaction. The next section unlocks automatically after verification succeeds.</div>}
      {verifyMessage[kind] && <div className={`notice ${status === 'verified' ? 'success' : status === 'error' ? 'danger' : ''}`}>{verifyMessage[kind]}</div>}
      {!unlocked && !target && <div className="notice">Locked until the previous contract is verified. If the previous card says DEPLOYED, do not redeploy it—wait for automatic verification or press Check verification.</div>}
    </section>;
  };

  return <main className="shell">
    <header className="hero">
      <div className="brandRow"><div className="mark">I</div><div><div className="eyebrow">INDEXIO V2.4 · BASE MAINNET</div><div className="networkPill"><i /> Base 8453</div></div></div>
      <h1>Indexio Deployment Center</h1>
      <p>Wallet-signed, sequential Base mainnet deployment. The Vault Deployer keeps Factory runtime safely below the EVM size limit; every contract is preflighted, validated and verified before the next step unlocks.</p>
    </header>

    <section className="statusGrid">
      <article><span>CORE DEPLOYS</span><b>5</b><small>One transaction each</small></article>
      <article><span>VERIFICATION</span><b>0 TX</b><small>Blockscout API only</small></article>
      <article><span>GOVERNANCE</span><b>2 + 2</b><small>Propose, then activate after delay</small></article>
      <article><span>SETTLEMENT</span><b>USDC</b><small>Native Base USDC</small></article>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">01</span><div><h2>Connect Base owner wallet</h2><p>The browser wallet signs every deployment and governance transaction. No deployer private key belongs in Vercel.</p></div></div>
      {!isConnected ? <button className="primary" disabled={!injected || busy === 'connect'} onClick={connectWallet}>{busy === 'connect' ? 'Opening wallet…' : 'Connect wallet'}</button> : <div className="walletBox"><div><span>CONNECTED WALLET</span><b>{address}</b></div><button className="ghost compact" onClick={() => disconnect()}>Disconnect</button></div>}
      {isConnected && !onBase && <button className="secondary" disabled={switching} onClick={() => switchChainAsync({ chainId: base.id })}>{switching ? 'Switching…' : 'Switch to Base Mainnet'}</button>}
      {isConnected && onBase && <div className="notice success">✓ Connected on Base mainnet (8453).</div>}
      <div className="notice strong">Vercel configuration: keep <code>BLOCKSCOUT_API_KEY</code> for verification. Do NOT add <code>DEPLOYER_PRIVATE_KEY</code> or <code>CONFIRM_MAINNET</code> for this wallet-signed deployer.</div>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">02</span><div><h2>Confirm constructor configuration</h2><p>These values become part of the deployed protocol. The connected wallet must equal Protocol Owner so the governance steps can be completed here.</p></div></div>
      <label className="field">PROTOCOL OWNER<input value={ownerInput} onChange={(e) => setOwnerInput(e.target.value.trim())} placeholder="0x…" /></label>
      <label className="field">FEE TREASURY<input value={treasuryInput} onChange={(e) => setTreasuryInput(e.target.value.trim())} placeholder="0x…" /></label>
      <div className="details" style={{ marginTop: 12 }}>
        <div><span>Settlement</span><code>{BASE_USDC}</code></div>
        <div><span>Network</span><strong>Base Mainnet · 8453</strong></div>
      </div>
      {owner && address && !ownerConnected && <div className="notice danger">Connected wallet does not match Protocol Owner. Connect <code>{owner}</code> before deploying.</div>}
      <label className="check"><input type="checkbox" checked={mainnetAccepted} onChange={(e) => setMainnetAccepted(e.target.checked)} /><span>I understand these are real Base mainnet transactions using real ETH for gas. Verification itself does not require an on-chain transaction.</span></label>
    </section>

    {stage('registry', '03', 'Use the existing verified Registry when available. This timelocked allowlist controls which assets future Indexio indexes may use.', !!ownerConnected && onBase && mainnetAccepted)}
    {stage('vaultDeployer', '04', 'Deploy the small stateless Vault Deployer. It isolates IndexioVault creation bytecode so the Factory stays below the EVM runtime-size limit.', verify.registry === 'verified')}
    {stage('factory', '05', 'Deploy the smaller Factory using the verified Registry, verified Vault Deployer, native Base USDC and the selected fee treasury.', verify.vaultDeployer === 'verified')}
    {stage('executionRouter', '06', 'Deploy the settlement-token execution path. It is NOT trusted by the Factory until governance proposes and later activates it.', verify.factory === 'verified')}
    {stage('rebalanceRouter', '07', 'Deploy the bounded governance-controlled rebalance path. It also remains inactive until the Factory timelock completes.', verify.executionRouter === 'verified')}

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">08</span><div><h2>Governance proposal 1 of 2</h2><p>Propose the verified Execution Router to the Factory. This starts the Factory's 2-day governance delay; it does not activate the router yet.</p></div></div>
      <div className="details"><div><span>Router</span><code>{addresses.executionRouter || 'Deploy core contracts first'}</code></div><div><span>Valid at</span><strong>{unixToText(executionValidAt)}</strong></div></div>
      {!executionValidAt && <button className="primary" disabled={!allVerified || !!busy} onClick={() => governanceTx('proposeExecutionRouter')}>{busy === 'proposeExecutionRouter' ? 'Proposing…' : 'Propose Execution Router'}</button>}
      {executionValidAt && <div className="notice success">✓ Proposal exists. No need to submit it again.</div>}
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">09</span><div><h2>Governance proposal 2 of 2</h2><p>Propose the verified Rebalance Router. This starts its own 2-day Factory governance delay.</p></div></div>
      <div className="details"><div><span>Router</span><code>{addresses.rebalanceRouter || 'Deploy core contracts first'}</code></div><div><span>Valid at</span><strong>{unixToText(rebalanceValidAt)}</strong></div></div>
      {!rebalanceValidAt && <button className="primary" disabled={!executionValidAt || !!busy} onClick={() => governanceTx('proposeRebalanceRouter')}>{busy === 'proposeRebalanceRouter' ? 'Proposing…' : 'Propose Rebalance Router'}</button>}
      {rebalanceValidAt && <div className="notice success">✓ Proposal exists. No need to submit it again.</div>}
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">10</span><div><h2>Wait for governance timelocks</h2><p>No transaction is required while waiting. The activation buttons below will reject execution until their respective on-chain validAt timestamps have passed.</p></div></div>
      <div className="details"><div><span>Execution</span><strong>{unixToText(executionValidAt)}</strong></div><div><span>Rebalance</span><strong>{unixToText(rebalanceValidAt)}</strong></div></div>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">11</span><div><h2>Activate Execution Router</h2><p>After the 2-day delay, this explicitly authorizes the verified Execution Router in the Factory.</p></div></div>
      {executionActive ? <div className="notice success">✓ Execution Router ACTIVE.</div> : <button className="secondary" disabled={!executionValidAt || !!busy} onClick={() => governanceTx('activateExecutionRouter')}>{busy === 'activateExecutionRouter' ? 'Activating…' : 'Activate Execution Router'}</button>}
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">12</span><div><h2>Activate Rebalance Router</h2><p>After its 2-day delay, this authorizes the verified Rebalance Router in the Factory. This is the last core governance transaction.</p></div></div>
      {rebalanceActive ? <div className="notice success">✓ Rebalance Router ACTIVE.</div> : <button className="secondary" disabled={!rebalanceValidAt || !executionActive || !!busy} onClick={() => governanceTx('activateRebalanceRouter')}>{busy === 'activateRebalanceRouter' ? 'Activating…' : 'Activate Rebalance Router'}</button>}
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">13</span><div><h2>Copy production contract configuration</h2><p>This block is always last so the final Base addresses can be copied directly into Indexio/Vercel after deployment.</p></div></div>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 14, borderRadius: 14, background: '#060d16', border: '1px solid rgba(255,255,255,.09)', color: '#d9e6f2', fontSize: 11, lineHeight: 1.7 }}>{copyBlock}</pre>
      <button className="primary" onClick={() => navigator.clipboard.writeText(copyBlock)}>Copy all contracts</button>
      <div className="notice">Core deployment total: 5 deployment transactions. Governance total: 2 proposal transactions + 2 activation transactions after the timelock. Blockscout verification creates no wallet transaction.</div>
      <button className="ghost reset" onClick={clearLocalState}>Clear browser-saved state only</button>
    </section>

    {notice && <section className="card"><div className="notice success">{notice}</div></section>}
    {error && <section className="card error"><b>Action stopped</b><p>{error}</p></section>}

    <footer>Indexio V2.4 · Base mainnet · The deployer never stores a private key. Existing ScanArc deployment tools remain available at <a href="/scanarc">/scanarc</a>.</footer>
  </main>;
}
