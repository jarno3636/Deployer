'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { base } from 'wagmi/chains';
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  isAddress,
  parseEther,
} from 'viem';

import {
  compilerVersion,
  launchArtifacts,
} from '../lib/launch.generated';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const LAUNCH_FEE_RECIPIENT = '0x5f9c24e66b74404bef89c1ef7222e1771a72fab9' as const;

const PRODUCTION_OWNER = '0x25BE27a17580F59206061B8823E3c0FbC1F7c52E' as const;
const ELIGIBILITY_PROVIDER_KEY = 'AiStocksStockEligibilityOptInV1' as const;
const PRODUCTION_LAUNCH_FEE_WEI = BigInt('1000000000000000');
const PRODUCTION_DEPLOYMENTS = {
  AiStocksAssetRegistryV1: '0x9A3d5bFCA8624F8Df27342E6aBCDA33A56C7e6Ca',
  AiStocksPolicyManagerV1: '0x7501B560C453D63aEAA0Ce565Ec2A50dDE11Cc2e',
  AiStocksIndexFactoryV1: '0xB3fC19f5c152559086DfF401F4D5c4A221f6b060',
  AiStocksIndexMintRouterV1: '0xc75f9cbbAf87a70Dd0a3369aa5D548cD5E5859C1',
  AiStocksIndexRedeemRouterV1: '0x4eb684888A6E5B10b8BC29f2600bf6ae4Bef1fA3',
} as const;

const REGISTRY_TOKENS = [
  BASE_USDC,
  '0x4200000000000000000000000000000000000006',
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
  '0xb20000000000000000000078ee7ce2fe4908108c',
  '0xb2000000000000000000008bc8786b856e61707c',
  '0xb200000000000000000000c2e324d24d7eecd1fb',
  '0xb2000000000000000000002d0ba3164cc74f58b7',
] as const;

const REGISTRY_CLASSES = [1, 2, 2, 3, 3, 3, 3] as const;
const REGISTRY_VERIFIED = [true, true, true, true, true, true, true] as const;
const REGISTRY_BLOCKED = [false, false, false, false, false, false, false] as const;
const REGISTRY_MAX_WEIGHTS = [6000, 6000, 6000, 6000, 6000, 6000, 6000] as const;

type CoreContractKey =
  | 'AiStocksAssetRegistryV1'
  | 'AiStocksPolicyManagerV1'
  | 'AiStocksIndexFactoryV1'
  | 'AiStocksIndexMintRouterV1'
  | 'AiStocksIndexRedeemRouterV1';

type ContractKey = CoreContractKey | typeof ELIGIBILITY_PROVIDER_KEY;

type AddressBook = Partial<Record<CoreContractKey, `0x${string}`>>;
type SetupState = {
  routersSet?: boolean;
  lifiAllowed?: boolean;
  registrySeeded?: boolean;
  redeemSystemAddress?: boolean;
  eligibilityProviderConnected?: boolean;
};

type VerificationState = 'idle' | 'submitting' | 'pending' | 'verified' | 'failed';

const CONTRACT_ORDER: CoreContractKey[] = [
  'AiStocksAssetRegistryV1',
  'AiStocksPolicyManagerV1',
  'AiStocksIndexFactoryV1',
  'AiStocksIndexMintRouterV1',
  'AiStocksIndexRedeemRouterV1',
];

const CONTRACT_LABELS: Record<CoreContractKey, string> = {
  AiStocksAssetRegistryV1: '1. Asset Registry',
  AiStocksPolicyManagerV1: '2. Policy Manager',
  AiStocksIndexFactoryV1: '3. Index Factory',
  AiStocksIndexMintRouterV1: '4. Mint Router',
  AiStocksIndexRedeemRouterV1: '5. Redeem Router',
};

function short(value?: string) {
  if (!value) return '—';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storageKey(owner: string) {
  return `aistocks-launch-v1:${owner.toLowerCase()}:8453`;
}

async function waitForCodeAtAddress(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  address: `0x${string}`,
  attempts = 10,
  delayMs = 2000,
) {
  for (let i = 0; i < attempts; i += 1) {
    const code = await publicClient.getBytecode({ address });
    if (code && code !== '0x') return true;
    await sleep(delayMs);
  }
  return false;
}

export function Deployer() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending: isConnecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: base.id });

  const [addresses, setAddresses] = useState<AddressBook>({});
  const [eligibilityProvider, setEligibilityProvider] = useState<`0x${string}` | null>(null);
  const [setup, setSetup] = useState<SetupState>({});
  const [launchFeeEth, setLaunchFeeEth] = useState('0.001');
  const [routerFeeRecipient, setRouterFeeRecipient] = useState<string>(LAUNCH_FEE_RECIPIENT);
  const [lifiTarget, setLifiTarget] = useState('');
  const [lifiSpender, setLifiSpender] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastHash, setLastHash] = useState<`0x${string}` | null>(null);
  const [verification, setVerification] = useState<Partial<Record<ContractKey, VerificationState>>>({});
  const [verificationMessage, setVerificationMessage] = useState<Partial<Record<ContractKey, string>>>({});

  const injected = useMemo(
    () => connectors.find((connector) => connector.id === 'injected'),
    [connectors],
  );

  const onBase = chainId === base.id;

  useEffect(() => {
    if (!address) return;
    try {
      const raw = localStorage.getItem(storageKey(address));
      if (!raw) return;
      const parsed = JSON.parse(raw) as { addresses?: AddressBook; setup?: SetupState; eligibilityProvider?: `0x${string}` | null };
      setAddresses(parsed.addresses ?? {});
      setSetup(parsed.setup ?? {});
      setEligibilityProvider(parsed.eligibilityProvider ?? null);
    } catch {
      // Ignore stale local storage.
    }
  }, [address]);

  useEffect(() => {
    if (!address) return;
    localStorage.setItem(storageKey(address), JSON.stringify({ addresses, setup, eligibilityProvider }));
  }, [address, addresses, setup, eligibilityProvider]);

  useEffect(() => {
    if (!eligibilityProvider || !publicClient) return;
    void refreshEligibilityProviderStatus(eligibilityProvider);
  }, [eligibilityProvider, publicClient]);

  async function ensureBase() {
    if (chainId !== base.id) await switchChainAsync({ chainId: base.id });
  }

  async function estimateAndSend(params: {
    to?: `0x${string}`;
    data: `0x${string}`;
  }) {
    if (!address || !walletClient || !publicClient) {
      throw new Error('Connect MetaMask first.');
    }

    await ensureBase();

    const request: { from: `0x${string}`; to?: `0x${string}`; data: `0x${string}` } = {
      from: address,
      data: params.data,
    };
    if (params.to) request.to = params.to;

    const rawEstimate = await publicClient.request({
      method: 'eth_estimateGas',
      params: [request],
    });
    const estimatedGas = BigInt(rawEstimate as `0x${string}`);
    const gasWithBuffer = (estimatedGas * BigInt(120) + BigInt(99)) / BigInt(100);
    const gas = `0x${gasWithBuffer.toString(16)}` as `0x${string}`;

    const txHash = (await walletClient.request({
      method: 'eth_sendTransaction',
      params: [{ ...request, gas }],
    })) as `0x${string}`;

    setLastHash(txHash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new Error('Transaction reverted.');
    return { txHash, receipt };
  }

  async function pollVerification(contractKey: ContractKey, guid: string) {
    setVerification((v) => ({ ...v, [contractKey]: 'pending' }));
    setVerificationMessage((v) => ({ ...v, [contractKey]: 'BaseScan verification processing…' }));

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(2500);
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', guid }),
      });
      const data = await response.json();

      if (data.verified) {
        setVerification((v) => ({ ...v, [contractKey]: 'verified' }));
        setVerificationMessage((v) => ({ ...v, [contractKey]: 'Verified on BaseScan ✓' }));
        return;
      }
      if (!data.pending && data.result) {
        setVerification((v) => ({ ...v, [contractKey]: 'failed' }));
        setVerificationMessage((v) => ({ ...v, [contractKey]: String(data.result) }));
        return;
      }
    }

    setVerification((v) => ({ ...v, [contractKey]: 'pending' }));
    setVerificationMessage((v) => ({ ...v, [contractKey]: 'Verification submitted; check BaseScan shortly.' }));
  }

  async function verifyContract(
    contractKey: ContractKey,
    contractAddress: `0x${string}`,
    constructorArguments: string,
  ) {
    setVerification((v) => ({ ...v, [contractKey]: 'submitting' }));
    setVerificationMessage((v) => ({ ...v, [contractKey]: 'Submitting verification…' }));

    try {
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submit',
          contractAddress,
          contractKey,
          constructorArguments,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Verification submission failed.');
      if (data.verified) {
        setVerification((v) => ({ ...v, [contractKey]: 'verified' }));
        setVerificationMessage((v) => ({ ...v, [contractKey]: 'Verified on BaseScan ✓' }));
        return;
      }
      if (data.guid) await pollVerification(contractKey, data.guid);
    } catch (verifyError) {
      setVerification((v) => ({ ...v, [contractKey]: 'failed' }));
      setVerificationMessage((v) => ({
        ...v,
        [contractKey]: verifyError instanceof Error ? verifyError.message : 'Verification failed.',
      }));
    }
  }

  function constructorFor(contractKey: CoreContractKey) {
    if (!address) throw new Error('Connect MetaMask first.');
    const registry = addresses.AiStocksAssetRegistryV1;
    const policy = addresses.AiStocksPolicyManagerV1;
    const factory = addresses.AiStocksIndexFactoryV1;

    if (contractKey === 'AiStocksAssetRegistryV1' || contractKey === 'AiStocksPolicyManagerV1') {
      return encodeAbiParameters([{ type: 'address' }], [address]);
    }

    if (contractKey === 'AiStocksIndexFactoryV1') {
      if (!registry || !policy) throw new Error('Deploy Registry and Policy Manager first.');
      let launchFeeWei: bigint;
      try {
        launchFeeWei = parseEther(launchFeeEth);
      } catch {
        throw new Error('Enter a valid launch fee in ETH.');
      }
      if (launchFeeWei === BigInt(0)) throw new Error('Factory launch fee cannot be zero.');
      return encodeAbiParameters(
        [
          { type: 'address', name: 'initialOwner' },
          { type: 'address', name: 'registry_' },
          { type: 'address', name: 'policyManager_' },
          { type: 'address', name: 'launchFeeRecipient_' },
          { type: 'uint256', name: 'launchFeeWei_' },
        ],
        [address, registry, policy, LAUNCH_FEE_RECIPIENT, launchFeeWei],
      );
    }

    if (!factory || !policy) throw new Error('Deploy the Factory first.');
    if (!isAddress(routerFeeRecipient)) throw new Error('Enter a valid router protocol fee recipient.');

    return encodeAbiParameters(
      [
        { type: 'address', name: 'initialOwner' },
        { type: 'address', name: 'usdc' },
        { type: 'address', name: 'factory_' },
        { type: 'address', name: 'policyManager_' },
        { type: 'address', name: 'feeRecipient' },
      ],
      [address, BASE_USDC, factory, policy, routerFeeRecipient as `0x${string}`],
    );
  }

  function productionConstructorFor(contractKey: CoreContractKey) {
    const registry = PRODUCTION_DEPLOYMENTS.AiStocksAssetRegistryV1;
    const policy = PRODUCTION_DEPLOYMENTS.AiStocksPolicyManagerV1;
    const factory = PRODUCTION_DEPLOYMENTS.AiStocksIndexFactoryV1;

    if (
      contractKey === 'AiStocksAssetRegistryV1' ||
      contractKey === 'AiStocksPolicyManagerV1'
    ) {
      return encodeAbiParameters(
        [{ type: 'address', name: 'initialOwner' }],
        [PRODUCTION_OWNER],
      );
    }

    if (contractKey === 'AiStocksIndexFactoryV1') {
      return encodeAbiParameters(
        [
          { type: 'address', name: 'initialOwner' },
          { type: 'address', name: 'registry_' },
          { type: 'address', name: 'policyManager_' },
          { type: 'address', name: 'launchFeeRecipient_' },
          { type: 'uint256', name: 'launchFeeWei_' },
        ],
        [
          PRODUCTION_OWNER,
          registry,
          policy,
          LAUNCH_FEE_RECIPIENT,
          PRODUCTION_LAUNCH_FEE_WEI,
        ],
      );
    }

    return encodeAbiParameters(
      [
        { type: 'address', name: 'initialOwner' },
        { type: 'address', name: 'usdc' },
        { type: 'address', name: 'factory_' },
        { type: 'address', name: 'policyManager_' },
        { type: 'address', name: 'feeRecipient' },
      ],
      [
        PRODUCTION_OWNER,
        BASE_USDC,
        factory,
        policy,
        LAUNCH_FEE_RECIPIENT,
      ],
    );
  }

  async function verifyExisting(contractKey: CoreContractKey) {
    const contractAddress = PRODUCTION_DEPLOYMENTS[contractKey];
    const constructorArguments = productionConstructorFor(contractKey).slice(2);
    await verifyContract(contractKey, contractAddress, constructorArguments);
  }

  async function verifyAllExisting() {
    setError(null);
    setBusy('verifyAll');

    try {
      for (const contractKey of CONTRACT_ORDER) {
        await verifyExisting(contractKey);
      }
    } catch (verifyAllError) {
      setError(
        verifyAllError instanceof Error
          ? verifyAllError.message
          : 'Verification failed.',
      );
    } finally {
      setBusy(null);
    }
  }

  function canDeploy(contractKey: CoreContractKey) {
    if (addresses[contractKey]) return false;
    if (contractKey === 'AiStocksAssetRegistryV1') return true;
    if (contractKey === 'AiStocksPolicyManagerV1') return Boolean(addresses.AiStocksAssetRegistryV1);
    if (contractKey === 'AiStocksIndexFactoryV1') {
      return Boolean(addresses.AiStocksAssetRegistryV1 && addresses.AiStocksPolicyManagerV1);
    }
    if (contractKey === 'AiStocksIndexMintRouterV1') return Boolean(addresses.AiStocksIndexFactoryV1);
    return Boolean(addresses.AiStocksIndexMintRouterV1 && addresses.AiStocksIndexFactoryV1);
  }

  async function deployContract(contractKey: CoreContractKey) {
    setError(null);
    setBusy(contractKey);

    try {
      if (!address || !walletClient || !publicClient) throw new Error('Connect MetaMask first.');
      const artifact = launchArtifacts[contractKey];
      const encodedArgs = constructorFor(contractKey);
      const constructorArguments = encodedArgs.slice(2);
      const deploymentData = `${artifact.bytecode}${constructorArguments}` as `0x${string}`;

      await ensureBase();
      const nonce = await publicClient.getTransactionCount({ address, blockTag: 'pending' });
      const predictedAddress = getContractAddress({ from: address, nonce: BigInt(nonce) });

      try {
        const { receipt } = await estimateAndSend({ data: deploymentData });
        const deployedAddress = receipt.contractAddress ?? predictedAddress;
        if (!receipt.contractAddress) {
          const hasCode = await waitForCodeAtAddress(publicClient, predictedAddress, 3, 1000);
          if (!hasCode) throw new Error('Deployment confirmed but no contract code was found.');
        }
        setAddresses((current) => ({ ...current, [contractKey]: deployedAddress }));
        void verifyContract(contractKey, deployedAddress, constructorArguments);
      } catch (sendError) {
        const landed = await waitForCodeAtAddress(publicClient, predictedAddress, 6, 1500);
        if (landed) {
          setAddresses((current) => ({ ...current, [contractKey]: predictedAddress }));
          void verifyContract(contractKey, predictedAddress, constructorArguments);
          return;
        }
        throw sendError;
      }
    } catch (deployError) {
      setError(deployError instanceof Error ? deployError.message : 'Deployment failed.');
    } finally {
      setBusy(null);
    }
  }

  async function callSetup(label: string, to: `0x${string}`, data: `0x${string}`, onDone: () => void) {
    setError(null);
    setBusy(label);
    try {
      await estimateAndSend({ to, data });
      onDone();
    } catch (setupError) {
      setError(setupError instanceof Error ? setupError.message : 'Setup transaction failed.');
    } finally {
      setBusy(null);
    }
  }

  async function setRouters() {
    const factory = addresses.AiStocksIndexFactoryV1;
    const mint = addresses.AiStocksIndexMintRouterV1;
    const redeem = addresses.AiStocksIndexRedeemRouterV1;
    if (!factory || !mint || !redeem) return;
    const data = encodeFunctionData({
      abi: launchArtifacts.AiStocksIndexFactoryV1.abi,
      functionName: 'setRouters',
      args: [mint, redeem],
    });
    await callSetup('setRouters', factory, data, () => setSetup((s) => ({ ...s, routersSet: true })));
  }

  async function allowLifi() {
    const mint = addresses.AiStocksIndexMintRouterV1;
    const redeem = addresses.AiStocksIndexRedeemRouterV1;
    if (!mint || !redeem) return;
    if (!isAddress(lifiTarget) || !isAddress(lifiSpender)) {
      setError('Enter valid current LI.FI target and approval/spender addresses from a reviewed quote.');
      return;
    }

    const target = lifiTarget as `0x${string}`;
    const spender = lifiSpender as `0x${string}`;
    const calls = [
      {
        to: mint,
        data: encodeFunctionData({ abi: launchArtifacts.AiStocksIndexMintRouterV1.abi, functionName: 'setTargetAllowed', args: [target, true] }),
      },
      {
        to: mint,
        data: encodeFunctionData({ abi: launchArtifacts.AiStocksIndexMintRouterV1.abi, functionName: 'setSpenderAllowed', args: [spender, true] }),
      },
      {
        to: redeem,
        data: encodeFunctionData({ abi: launchArtifacts.AiStocksIndexRedeemRouterV1.abi, functionName: 'setTargetAllowed', args: [target, true] }),
      },
      {
        to: redeem,
        data: encodeFunctionData({ abi: launchArtifacts.AiStocksIndexRedeemRouterV1.abi, functionName: 'setSpenderAllowed', args: [spender, true] }),
      },
    ];

    setError(null);
    setBusy('lifi');
    try {
      for (const call of calls) await estimateAndSend(call);
      setSetup((s) => ({ ...s, lifiAllowed: true }));
    } catch (allowError) {
      setError(allowError instanceof Error ? allowError.message : 'LI.FI allowlist setup failed.');
    } finally {
      setBusy(null);
    }
  }

  async function seedRegistry() {
    const registry = addresses.AiStocksAssetRegistryV1;
    if (!registry) return;
    const data = encodeFunctionData({
      abi: launchArtifacts.AiStocksAssetRegistryV1.abi,
      functionName: 'configureAssets',
      args: [
        [...REGISTRY_TOKENS],
        [...REGISTRY_CLASSES],
        [...REGISTRY_VERIFIED],
        [...REGISTRY_BLOCKED],
        [...REGISTRY_MAX_WEIGHTS],
      ],
    });
    await callSetup('seedRegistry', registry, data, () => setSetup((s) => ({ ...s, registrySeeded: true })));
  }

  async function setRedeemSystemAddress() {
    const policy = addresses.AiStocksPolicyManagerV1;
    const redeem = addresses.AiStocksIndexRedeemRouterV1;
    if (!policy || !redeem) return;
    const data = encodeFunctionData({
      abi: launchArtifacts.AiStocksPolicyManagerV1.abi,
      functionName: 'setSystemAddress',
      args: [redeem, true],
    });
    await callSetup('systemAddress', policy, data, () => setSetup((s) => ({ ...s, redeemSystemAddress: true })));
  }

  async function refreshEligibilityProviderStatus(providerAddress = eligibilityProvider) {
    if (!publicClient) return;
    try {
      // Use a raw eth_call here instead of readContract. With the viem/wagmi
      // versions used by this deployer, the generated EIP-7702 overload can
      // incorrectly require `authorizationList` at TypeScript build time.
      // This is the same read-only onchain call without that type-level issue.
      const callData = encodeFunctionData({
        abi: launchArtifacts.AiStocksPolicyManagerV1.abi,
        functionName: 'eligibilityProvider',
      });
      const raw = await publicClient.request({
        method: 'eth_call',
        params: [
          {
            to: PRODUCTION_DEPLOYMENTS.AiStocksPolicyManagerV1,
            data: callData,
          },
          'latest',
        ],
      });
      const current = decodeAbiParameters(
        [{ type: 'address' }],
        raw as `0x${string}`,
      )[0];
      const connected = Boolean(
        providerAddress && current.toLowerCase() === providerAddress.toLowerCase(),
      );
      setSetup((state) => ({ ...state, eligibilityProviderConnected: connected }));
    } catch {
      // A temporary RPC failure should not erase saved deployment state.
    }
  }

  async function deployEligibilityProvider() {
    setError(null);
    setBusy('eligibilityProviderDeploy');

    try {
      if (!address || !walletClient || !publicClient) throw new Error('Connect MetaMask first.');
      const artifact = launchArtifacts.AiStocksStockEligibilityOptInV1;
      const deploymentData = artifact.bytecode as `0x${string}`;

      await ensureBase();
      const nonce = await publicClient.getTransactionCount({ address, blockTag: 'pending' });
      const predictedAddress = getContractAddress({ from: address, nonce: BigInt(nonce) });

      try {
        const { receipt } = await estimateAndSend({ data: deploymentData });
        const deployedAddress = receipt.contractAddress ?? predictedAddress;
        if (!receipt.contractAddress) {
          const hasCode = await waitForCodeAtAddress(publicClient, predictedAddress, 4, 1000);
          if (!hasCode) throw new Error('Deployment confirmed but no provider contract code was found.');
        }
        setEligibilityProvider(deployedAddress);
        setSetup((state) => ({ ...state, eligibilityProviderConnected: false }));
        void verifyContract(ELIGIBILITY_PROVIDER_KEY, deployedAddress, '');
      } catch (sendError) {
        const landed = await waitForCodeAtAddress(publicClient, predictedAddress, 6, 1500);
        if (!landed) throw sendError;
        setEligibilityProvider(predictedAddress);
        setSetup((state) => ({ ...state, eligibilityProviderConnected: false }));
        void verifyContract(ELIGIBILITY_PROVIDER_KEY, predictedAddress, '');
      }
    } catch (deployError) {
      setError(deployError instanceof Error ? deployError.message : 'Eligibility provider deployment failed.');
    } finally {
      setBusy(null);
    }
  }

  async function verifyEligibilityProvider() {
    if (!eligibilityProvider) return;
    await verifyContract(ELIGIBILITY_PROVIDER_KEY, eligibilityProvider, '');
  }

  async function connectEligibilityProvider() {
    if (!eligibilityProvider) return;
    if (!address || address.toLowerCase() !== PRODUCTION_OWNER.toLowerCase()) {
      setError(`Connect the AiStocks owner wallet ${PRODUCTION_OWNER} to change the Policy Manager.`);
      return;
    }

    const data = encodeFunctionData({
      abi: launchArtifacts.AiStocksPolicyManagerV1.abi,
      functionName: 'setEligibilityProvider',
      args: [eligibilityProvider],
    });

    await callSetup(
      'connectEligibilityProvider',
      PRODUCTION_DEPLOYMENTS.AiStocksPolicyManagerV1,
      data,
      () => setSetup((state) => ({ ...state, eligibilityProviderConnected: true })),
    );

    await refreshEligibilityProviderStatus(eligibilityProvider);
  }

  function clearSavedDeployment() {
    if (address) localStorage.removeItem(storageKey(address));
    setAddresses({});
    setEligibilityProvider(null);
    setSetup({});
    setLastHash(null);
    setVerification({});
    setVerificationMessage({});
    setError(null);
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="mark">AI</div>
        <p className="eyebrow">AISTOCKS · BASE MAINNET</p>
        <h1>Index Launch V1 Deployer</h1>
        <p className="lede">Deploy five contracts in order, then finish the required production setup.</p>
      </section>

      <section className="card">
        <div className="row"><span>Network</span><b className="good">Base · 8453</b></div>
        <div className="row"><span>Owner</span><b>{short(address)}</b></div>
        <div className="row"><span>Compiler</span><b>{compilerVersion.split('+')[0]}</b></div>
        <div className="row"><span>Base USDC</span><b>{short(BASE_USDC)}</b></div>
        <div className="row"><span>Launch fee recipient</span><b>{short(LAUNCH_FEE_RECIPIENT)}</b></div>
      </section>

      {!isConnected ? (
        <section className="actions">
          <button
            className="primary"
            disabled={!injected || isConnecting}
            onClick={() => injected && connect({ connector: injected })}
          >
            {isConnecting ? 'Opening MetaMask…' : 'Connect MetaMask'}
          </button>
        </section>
      ) : (
        <section className="actions">
          <div className="walletLine">
            <div><span>Connected</span><b>{short(address)}</b></div>
            <button className="textButton" onClick={() => disconnect()}>Disconnect</button>
          </div>
          {!onBase && (
            <button className="primary" disabled={isSwitching} onClick={() => switchChainAsync({ chainId: base.id })}>
              {isSwitching ? 'Switching…' : 'Switch to Base'}
            </button>
          )}
        </section>
      )}

      <section className="card">
        <h2>Deployment settings</h2>
        <label className="field">
          <span>User index launch fee (ETH)</span>
          <input value={launchFeeEth} onChange={(e) => setLaunchFeeEth(e.target.value)} inputMode="decimal" placeholder="0.001" />
        </label>
        <p className="hint">This becomes the Factory&apos;s launchFeeWei. It must be greater than zero.</p>
        <label className="field">
          <span>Mint/Redeem router protocol fee recipient</span>
          <input value={routerFeeRecipient} onChange={(e) => setRouterFeeRecipient(e.target.value)} autoCapitalize="none" autoCorrect="off" />
        </label>
      </section>

      <section className="card">
        <h2>Deploy in order</h2>
        {CONTRACT_ORDER.map((contractKey) => {
          const deployed = addresses[contractKey];
          const verificationState = verification[contractKey];
          return (
            <div className="deployStep" key={contractKey}>
              <div>
                <b>{CONTRACT_LABELS[contractKey]}</b>
                <p>{deployed ? `Deployed: ${short(deployed)}` : 'Not deployed'}</p>
                {verificationState && verificationState !== 'idle' && (
                  <p className={verificationState === 'verified' ? 'good' : ''}>{verificationMessage[contractKey]}</p>
                )}
              </div>
              {deployed ? (
                <a href={`https://basescan.org/address/${deployed}`} target="_blank" rel="noreferrer">BaseScan ↗</a>
              ) : (
                <button
                  className="primary"
                  disabled={!isConnected || !onBase || !canDeploy(contractKey) || busy !== null}
                  onClick={() => deployContract(contractKey)}
                >
                  {busy === contractKey ? 'Deploying…' : 'Deploy'}
                </button>
              )}
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2>Verify deployed contracts</h2>
        <p className="hint">
          These are the existing Base production deployments. Verification uses
          the exact Solidity Standard JSON, Solidity 0.8.30, viaIR, optimizer
          settings, and constructor arguments used for this deployment. No wallet
          transaction is required.
        </p>

        <button
          className="primary"
          disabled={busy !== null}
          onClick={verifyAllExisting}
        >
          {busy === 'verifyAll' ? 'Verifying all 5…' : 'Verify all 5 on BaseScan'}
        </button>

        {CONTRACT_ORDER.map((contractKey) => {
          const deployed = PRODUCTION_DEPLOYMENTS[contractKey];
          const state = verification[contractKey];
          const message = verificationMessage[contractKey];

          return (
            <div className="deployStep" key={`verify-${contractKey}`}>
              <div>
                <b>{CONTRACT_LABELS[contractKey]}</b>
                <p>{deployed}</p>
                {message && (
                  <p className={state === 'verified' ? 'good' : ''}>
                    {message}
                  </p>
                )}
              </div>

              <div>
                <a
                  href={`https://basescan.org/address/${deployed}#code`}
                  target="_blank"
                  rel="noreferrer"
                >
                  BaseScan ↗
                </a>
                <button
                  className="secondary"
                  disabled={busy !== null || state === 'submitting' || state === 'pending'}
                  onClick={() => verifyExisting(contractKey)}
                >
                  {state === 'verified'
                    ? 'Verified ✓'
                    : state === 'submitting'
                      ? 'Submitting…'
                      : state === 'pending'
                        ? 'Processing…'
                        : 'Verify'}
                </button>
              </div>
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2>Required setup after deployment</h2>

        <div className="deployStep">
          <div><b>6. Factory setRouters</b><p>Must be done before any index launch.</p></div>
          <button className="primary" disabled={Boolean(setup.routersSet) || !addresses.AiStocksIndexRedeemRouterV1 || busy !== null} onClick={setRouters}>
            {setup.routersSet ? 'Done ✓' : busy === 'setRouters' ? 'Confirming…' : 'Set routers'}
          </button>
        </div>

        <div className="deployStep">
          <div>
            <b>7. Allow reviewed LI.FI route addresses</b>
            <p>Use the current target and approvalAddress from the production LI.FI quote path. Do not guess these.</p>
          </div>
        </div>
        <label className="field"><span>LI.FI target / Diamond</span><input value={lifiTarget} onChange={(e) => setLifiTarget(e.target.value)} placeholder="0x…" autoCapitalize="none" /></label>
        <label className="field"><span>LI.FI approval / spender</span><input value={lifiSpender} onChange={(e) => setLifiSpender(e.target.value)} placeholder="0x…" autoCapitalize="none" /></label>
        <button className="primary" disabled={Boolean(setup.lifiAllowed) || !setup.routersSet || busy !== null} onClick={allowLifi}>
          {setup.lifiAllowed ? 'LI.FI allowed ✓' : busy === 'lifi' ? 'Confirm 4 transactions…' : 'Allow on both routers'}
        </button>

        <div className="deployStep">
          <div><b>8. Seed asset registry</b><p>USDC, WETH, cbBTC, NVDAc, METAc, AAPLc, GOOGLc.</p></div>
          <button className="primary" disabled={Boolean(setup.registrySeeded) || !addresses.AiStocksAssetRegistryV1 || busy !== null} onClick={seedRegistry}>
            {setup.registrySeeded ? 'Seeded ✓' : busy === 'seedRegistry' ? 'Confirming…' : 'Seed registry'}
          </button>
        </div>

        <div className="deployStep">
          <div><b>9. Allow Redeem Router as system address</b><p>Required for restricted stock-index shares entering redemption.</p></div>
          <button className="primary" disabled={Boolean(setup.redeemSystemAddress) || !addresses.AiStocksIndexRedeemRouterV1 || busy !== null} onClick={setRedeemSystemAddress}>
            {setup.redeemSystemAddress ? 'Done ✓' : busy === 'systemAddress' ? 'Confirming…' : 'Set system address'}
          </button>
        </div>
      </section>


      <section className="card">
        <h2>Stock index eligibility provider</h2>
        <p className="hint">
          This is the one missing piece for the new self-service “Enable stock indexes” button.
          It does not replace any of the five production contracts above.
        </p>

        <div className="deployStep">
          <div>
            <b>1. Deploy eligibility provider</b>
            <p>{eligibilityProvider ? `Deployed: ${short(eligibilityProvider)}` : 'Not deployed yet.'}</p>
            {verificationMessage[ELIGIBILITY_PROVIDER_KEY] && (
              <p className={verification[ELIGIBILITY_PROVIDER_KEY] === 'verified' ? 'good' : ''}>
                {verificationMessage[ELIGIBILITY_PROVIDER_KEY]}
              </p>
            )}
          </div>
          {eligibilityProvider ? (
            <a href={`https://basescan.org/address/${eligibilityProvider}#code`} target="_blank" rel="noreferrer">BaseScan ↗</a>
          ) : (
            <button
              className="primary"
              disabled={!isConnected || !onBase || busy !== null}
              onClick={deployEligibilityProvider}
            >
              {busy === 'eligibilityProviderDeploy' ? 'Deploying…' : 'Deploy provider'}
            </button>
          )}
        </div>

        {eligibilityProvider && verification[ELIGIBILITY_PROVIDER_KEY] !== 'verified' && (
          <button
            className="secondary"
            disabled={busy !== null || verification[ELIGIBILITY_PROVIDER_KEY] === 'submitting' || verification[ELIGIBILITY_PROVIDER_KEY] === 'pending'}
            onClick={verifyEligibilityProvider}
          >
            {verification[ELIGIBILITY_PROVIDER_KEY] === 'pending' ? 'Verification processing…' : 'Verify provider on BaseScan'}
          </button>
        )}

        <div className="deployStep">
          <div>
            <b>2. Connect provider to production Policy Manager</b>
            <p>Writes setEligibilityProvider(provider) to {short(PRODUCTION_DEPLOYMENTS.AiStocksPolicyManagerV1)}.</p>
            <p className={setup.eligibilityProviderConnected ? 'good' : ''}>
              {setup.eligibilityProviderConnected
                ? 'Connected onchain ✓'
                : verification[ELIGIBILITY_PROVIDER_KEY] === 'verified'
                  ? 'Provider verified. Ready to connect.'
                  : 'Deploy and verify the provider first.'}
            </p>
          </div>
          <button
            className="primary"
            disabled={!eligibilityProvider || verification[ELIGIBILITY_PROVIDER_KEY] !== 'verified' || !isConnected || !onBase || Boolean(setup.eligibilityProviderConnected) || busy !== null}
            onClick={connectEligibilityProvider}
          >
            {setup.eligibilityProviderConnected
              ? 'Connected ✓'
              : busy === 'connectEligibilityProvider'
                ? 'Confirming…'
                : 'Connect to Policy Manager'}
          </button>
        </div>

        <p className="hint">
          Use the AiStocks owner wallet for step 2. After it confirms, the app can let each user opt in from their own wallet.
        </p>
      </section>

      {lastHash && (
        <section className="result pending">
          <span>Latest transaction</span>
          <a href={`https://basescan.org/tx/${lastHash}`} target="_blank" rel="noreferrer">{short(lastHash)} ↗</a>
        </section>
      )}

      {(error || connectError) && (
        <section className="result error">
          <span>Needs attention</span>
          <p>{error ?? connectError?.message}</p>
        </section>
      )}

      <section className="safety">
        <b>Production note</b>
        <p>This deployer enforces the documented deployment order and keeps source verification automatic, but the uploaded architecture explicitly remains unaudited beta code. Do not put meaningful TVL through it before independent audit and production route review.</p>
        <button className="secondary" onClick={clearSavedDeployment}>Clear saved deployment state</button>
      </section>
    </main>
  );
}
