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
  encodeAbiParameters,
  getContractAddress,
  isAddress,
} from 'viem';

import {
  indexRouterBytecode,
  compilerVersion,
} from '../lib/index-router.generated';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

type VerificationState =
  | 'idle'
  | 'submitting'
  | 'pending'
  | 'verified'
  | 'failed';

function short(value?: string) {
  if (!value) return '—';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const {
    connectors,
    connect,
    isPending: isConnecting,
    error: connectError,
  } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: base.id });

  const [feeRecipient, setFeeRecipient] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [contractAddress, setContractAddress] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verificationState, setVerificationState] =
    useState<VerificationState>('idle');
  const [verificationMessage, setVerificationMessage] =
    useState<string | null>(null);
  const [verificationGuid, setVerificationGuid] = useState<string | null>(null);
  const [deployedConstructorArguments, setDeployedConstructorArguments] =
    useState<string | null>(null);

  const onBase = chainId === base.id;

  const injected = useMemo(
    () => connectors.find((connector) => connector.id === 'injected'),
    [connectors],
  );

  useEffect(() => {
    if (address && !feeRecipient) setFeeRecipient(address);
  }, [address, feeRecipient]);

  async function checkVerificationStatus(guid: string) {
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', guid }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Could not check verification status.');
    }

    return data as {
      verified?: boolean;
      pending?: boolean;
      result?: string;
    };
  }

  async function pollVerification(guid: string) {
    setVerificationState('pending');
    setVerificationMessage('BaseScan verification is processing…');

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(2500);

      try {
        const status = await checkVerificationStatus(guid);

        if (status.verified) {
          setVerificationState('verified');
          setVerificationMessage('Source code verified on BaseScan.');
          return;
        }

        if (!status.pending && status.result) {
          setVerificationState('failed');
          setVerificationMessage(status.result);
          return;
        }
      } catch (statusError) {
        if (attempt === 11) {
          setVerificationState('failed');
          setVerificationMessage(
            statusError instanceof Error
              ? statusError.message
              : 'Could not confirm verification status.',
          );
          return;
        }
      }
    }

    setVerificationState('pending');
    setVerificationMessage(
      'Verification was submitted and is still processing. Check BaseScan shortly.',
    );
  }

  async function verifyContract(
    deployedAddress: `0x${string}`,
    constructorArguments: string,
  ) {
    setVerificationState('submitting');
    setVerificationMessage('Submitting source code to BaseScan…');
    setVerificationGuid(null);

    try {
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submit',
          contractAddress: deployedAddress,
          constructorArguments,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Verification submission failed.');
      }

      if (data.verified) {
        setVerificationState('verified');
        setVerificationMessage('Source code is already verified on BaseScan.');
        return;
      }

      if (!data.guid) {
        throw new Error(
          'Verification was submitted but no verification ID was returned.',
        );
      }

      setVerificationGuid(data.guid);
      await pollVerification(data.guid);
    } catch (verificationError) {
      setVerificationState('failed');
      setVerificationMessage(
        verificationError instanceof Error
          ? verificationError.message
          : 'Verification failed.',
      );
    }
  }

  async function retryVerification() {
    if (!contractAddress || !deployedConstructorArguments) return;

    if (verificationState === 'pending' && verificationGuid) {
      await pollVerification(verificationGuid);
      return;
    }

    await verifyContract(contractAddress, deployedConstructorArguments);
  }

  async function deploy() {
    setError(null);
    setHash(null);
    setContractAddress(null);
    setVerificationState('idle');
    setVerificationMessage(null);
    setVerificationGuid(null);
    setDeployedConstructorArguments(null);

    try {
      if (!address || !walletClient || !publicClient) {
        throw new Error('Connect a wallet first.');
      }

      if (!isAddress(feeRecipient)) {
        throw new Error('Enter a valid fee recipient address.');
      }

      if (chainId !== base.id) {
        await switchChainAsync({ chainId: base.id });
      }

      const constructorArgs = encodeAbiParameters(
        [
          { type: 'address', name: 'usdc_' },
          { type: 'address', name: 'feeRecipient_' },
          { type: 'address', name: 'owner_' },
        ],
        [
          BASE_USDC as `0x${string}`,
          feeRecipient as `0x${string}`,
          address,
        ],
      );

      const constructorArguments = constructorArgs.slice(2);
      const deploymentData =
        `${indexRouterBytecode}${constructorArguments}` as `0x${string}`;

      setDeployedConstructorArguments(constructorArguments);
      setDeploying(true);

      const deploymentNonce = await publicClient.getTransactionCount({
        address,
        blockTag: 'pending',
      });

      const predictedAddress = getContractAddress({
        from: address,
        nonce: BigInt(deploymentNonce),
      });

      let estimatedGas: bigint;

      try {
        const rawEstimate = await publicClient.request({
          method: 'eth_estimateGas',
          params: [
            {
              from: address,
              data: deploymentData,
            },
          ],
        });

        estimatedGas = BigInt(rawEstimate as `0x${string}`);
      } catch (estimateError) {
        const estimateMessage =
          estimateError instanceof Error
            ? estimateError.message
            : String(estimateError);

        throw new Error(
          `Base could not estimate deployment gas before opening MetaMask. ${estimateMessage}`,
        );
      }

      const gasWithBuffer =
        (estimatedGas * BigInt(120) + BigInt(99)) / BigInt(100);
      const gasHex = `0x${gasWithBuffer.toString(16)}` as `0x${string}`;

      let txHash: `0x${string}`;

      try {
        txHash = (await walletClient.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: address,
              data: deploymentData,
              gas: gasHex,
            },
          ],
        })) as `0x${string}`;
      } catch (walletError) {
        const landed = await waitForCodeAtAddress(
          publicClient,
          predictedAddress,
          10,
          2000,
        );

        if (landed) {
          setContractAddress(predictedAddress);
          setDeploying(false);
          void verifyContract(predictedAddress, constructorArguments);
          return;
        }

        const walletMessage =
          walletError instanceof Error ? walletError.message : String(walletError);

        throw new Error(walletMessage);
      }

      setHash(txHash);

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status !== 'success') {
        throw new Error('Deployment transaction reverted.');
      }

      const deployedAddress = receipt.contractAddress ?? predictedAddress;

      if (!receipt.contractAddress) {
        const hasCode = await waitForCodeAtAddress(
          publicClient,
          predictedAddress,
          3,
          1000,
        );

        if (!hasCode) {
          throw new Error(
            'Deployment transaction confirmed but no contract code was found at the predicted address.',
          );
        }
      }

      setContractAddress(deployedAddress);
      setDeploying(false);
      void verifyContract(deployedAddress, constructorArguments);
    } catch (deploymentError) {
      setError(
        deploymentError instanceof Error
          ? deploymentError.message
          : 'Deployment failed.',
      );
      setDeploying(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="mark">AI</div>
        <p className="eyebrow">AISTOCKS · BASE</p>
        <h1>Index Router Deployer</h1>
        <p className="lede">Deploy AiStocksIndexRouterV1 directly to Base.</p>
      </section>

      <section className="card">
        <div className="row strong">
          <span>Contract</span>
          <b>AiStocksIndexRouterV1</b>
        </div>
        <div className="row">
          <span>Network</span>
          <b className="good">Base Mainnet · 8453</b>
        </div>
        <div className="row">
          <span>USDC</span>
          <b>{short(BASE_USDC)}</b>
        </div>
        <div className="row">
          <span>Fee</span>
          <b>1%</b>
        </div>
        <div className="row">
          <span>Owner</span>
          <b>{short(address)}</b>
        </div>
        <div className="row">
          <span>Compiler</span>
          <b>{compilerVersion.split('+')[0]}</b>
        </div>
        <div className="row">
          <span>Verification</span>
          <b className="good">Automatic</b>
        </div>
      </section>

      {isConnected && (
        <section className="card">
          <div style={{ display: 'grid', gap: 10, width: '100%' }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Fee recipient</span>
              <input
                value={feeRecipient}
                onChange={(event) => setFeeRecipient(event.target.value.trim())}
                inputMode="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '14px 12px',
                  borderRadius: 12,
                  border: '1px solid rgba(255,255,255,.14)',
                  background: 'rgba(255,255,255,.05)',
                  color: 'inherit',
                  fontSize: 14,
                }}
              />
            </label>
            <p className="hint" style={{ margin: 0 }}>
              Owner defaults to the connected wallet. You can change the fee recipient later from the owner wallet.
            </p>
          </div>
        </section>
      )}

      {!isConnected ? (
        <section className="actions">
          <button
            className="primary"
            disabled={!injected || isConnecting}
            onClick={() => injected && connect({ connector: injected })}
          >
            {isConnecting ? 'Opening MetaMask…' : 'Connect MetaMask'}
          </button>
          <p className="hint">Make sure MetaMask is on Base Mainnet.</p>
        </section>
      ) : (
        <section className="actions">
          <div className="walletLine">
            <div>
              <span>Connected</span>
              <b>{short(address)}</b>
            </div>
            <button className="textButton" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>

          {!onBase ? (
            <button
              className="primary"
              disabled={isSwitching}
              onClick={() => switchChainAsync({ chainId: base.id })}
            >
              {isSwitching ? 'Switching…' : 'Switch to Base'}
            </button>
          ) : (
            <button
              className="primary deploy"
              disabled={deploying || !isAddress(feeRecipient)}
              onClick={deploy}
            >
              {deploying ? 'Deploying…' : 'Deploy Index Router'}
            </button>
          )}
        </section>
      )}

      {hash && (
        <section className="result pending">
          <span>Transaction submitted</span>
          <a href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noreferrer">
            {short(hash)} ↗
          </a>
        </section>
      )}

      {contractAddress && (
        <section className="result success">
          <span>Index Router deployed ✓</span>
          <strong>{contractAddress}</strong>
          <a
            href={`https://basescan.org/address/${contractAddress}`}
            target="_blank"
            rel="noreferrer"
          >
            View contract on BaseScan ↗
          </a>
        </section>
      )}

      {contractAddress && verificationState !== 'idle' && (
        <section
          className={`result ${
            verificationState === 'verified'
              ? 'success'
              : verificationState === 'failed'
                ? 'error'
                : 'pending'
          }`}
        >
          <span>
            {verificationState === 'verified'
              ? 'BaseScan verified ✓'
              : verificationState === 'failed'
                ? 'Verification needs attention'
                : 'Verifying source code…'}
          </span>
          {verificationMessage && <p>{verificationMessage}</p>}
          {(verificationState === 'failed' || verificationState === 'pending') && (
            <button className="secondary" onClick={retryVerification}>
              {verificationState === 'pending'
                ? 'Check verification again'
                : 'Retry verification'}
            </button>
          )}
        </section>
      )}

      {(error || connectError) && (
        <section className="result error">
          <span>Couldn’t complete deployment</span>
          <p>{error ?? connectError?.message}</p>
        </section>
      )}

      <section className="safety">
        <b>Deployment setup</b>
        <p>
          Base native USDC is prefilled. The connected wallet is used as owner.
          The router takes the contract’s fixed 1% fee and automatically submits
          the exact constructor arguments for BaseScan verification.
        </p>
      </section>
    </main>
  );
}
