'use client';

import { useMemo, useState } from 'react';
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { base } from 'wagmi/chains';
import { getContractAddress } from 'viem';

import {
  marketplaceBytecode,
  compilerVersion,
} from '../lib/marketplace.generated';

const FEE_RECIPIENT =
  '0x0ba4aB96AFfe0486DeB9a04B9dB53B0c1a65f2d8';

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

    if (code && code !== '0x') {
      return true;
    }

    await sleep(delayMs);
  }

  return false;
}

export function Deployer() {
  const {
    address,
    chainId,
    isConnected,
  } = useAccount();

  const {
    connectors,
    connect,
    isPending: isConnecting,
    error: connectError,
  } = useConnect();

  const {
    disconnect,
  } = useDisconnect();

  const {
    switchChainAsync,
    isPending: isSwitching,
  } = useSwitchChain();

  const {
    data: walletClient,
  } = useWalletClient();

  const publicClient =
    usePublicClient({
      chainId: base.id,
    });

  const [deploying, setDeploying] =
    useState(false);

  const [hash, setHash] =
    useState<`0x${string}` | null>(null);

  const [
    contractAddress,
    setContractAddress,
  ] =
    useState<`0x${string}` | null>(null);

  const [error, setError] =
    useState<string | null>(null);

  const [
    verificationState,
    setVerificationState,
  ] =
    useState<VerificationState>('idle');

  const [
    verificationMessage,
    setVerificationMessage,
  ] =
    useState<string | null>(null);

  const [
    verificationGuid,
    setVerificationGuid,
  ] =
    useState<string | null>(null);

  const onBase =
    chainId === base.id;

  const injected =
    useMemo(
      () =>
        connectors.find(
          (connector) =>
            connector.id === 'injected',
        ),
      [connectors],
    );

  async function checkVerificationStatus(
    guid: string,
  ) {
    const response =
      await fetch('/api/verify', {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',
        },

        body: JSON.stringify({
          action: 'status',
          guid,
        }),
      });

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
          'Could not check verification status.',
      );
    }

    return data as {
      verified?: boolean;
      pending?: boolean;
      result?: string;
    };
  }

  async function pollVerification(
    guid: string,
  ) {
    setVerificationState(
      'pending',
    );

    setVerificationMessage(
      'BaseScan verification is processing…',
    );

    for (
      let attempt = 0;
      attempt < 12;
      attempt += 1
    ) {
      await sleep(2500);

      try {
        const status =
          await checkVerificationStatus(
            guid,
          );

        if (status.verified) {
          setVerificationState(
            'verified',
          );

          setVerificationMessage(
            'Source code verified on BaseScan.',
          );

          return;
        }

        if (
          !status.pending &&
          status.result
        ) {
          setVerificationState(
            'failed',
          );

          setVerificationMessage(
            status.result,
          );

          return;
        }
      } catch (statusError) {
        if (attempt === 11) {
          setVerificationState(
            'failed',
          );

          setVerificationMessage(
            statusError instanceof Error
              ? statusError.message
              : 'Could not confirm verification status.',
          );

          return;
        }
      }
    }

    setVerificationState(
      'pending',
    );

    setVerificationMessage(
      'Verification was submitted and is still processing. Check BaseScan shortly.',
    );
  }

  async function verifyContract(
    deployedAddress: `0x${string}`,
  ) {
    setVerificationState(
      'submitting',
    );

    setVerificationMessage(
      'Submitting source code to BaseScan…',
    );

    setVerificationGuid(null);

    try {
      const response =
        await fetch('/api/verify', {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',
          },

          body: JSON.stringify({
            action: 'submit',

            contractAddress:
              deployedAddress,
          }),
        });

      const data =
        await response.json();

      if (
        !response.ok ||
        !data.ok
      ) {
        throw new Error(
          data.error ||
            'Verification submission failed.',
        );
      }

      if (data.verified) {
        setVerificationState(
          'verified',
        );

        setVerificationMessage(
          'Source code is already verified on BaseScan.',
        );

        return;
      }

      if (!data.guid) {
        throw new Error(
          'Verification was submitted but no verification ID was returned.',
        );
      }

      setVerificationGuid(
        data.guid,
      );

      await pollVerification(
        data.guid,
      );
    } catch (
      verificationError
    ) {
      setVerificationState(
        'failed',
      );

      setVerificationMessage(
        verificationError instanceof Error
          ? verificationError.message
          : 'Verification failed.',
      );
    }
  }

  async function retryVerification() {
    if (!contractAddress) {
      return;
    }

    if (
      verificationState ===
        'pending' &&
      verificationGuid
    ) {
      await pollVerification(
        verificationGuid,
      );

      return;
    }

    await verifyContract(
      contractAddress,
    );
  }

  async function deploy() {
    setError(null);
    setHash(null);
    setContractAddress(null);

    setVerificationState(
      'idle',
    );

    setVerificationMessage(
      null,
    );

    setVerificationGuid(null);

    try {
      if (
        !address ||
        !walletClient ||
        !publicClient
      ) {
        throw new Error(
          'Connect a wallet first.',
        );
      }

      if (
        chainId !== base.id
      ) {
        await switchChainAsync({
          chainId: base.id,
        });
      }

      setDeploying(true);

      /*
       * Constructor has zero arguments.
       *
       * The contract creation transaction
       * therefore contains only the compiled
       * creation bytecode.
       *
       * Use raw eth_sendTransaction here
       * instead of viem deployContract() or
       * sendTransaction() to avoid the kzg
       * generic type inference issue.
       */
      /*
       * Predict the CREATE address before asking the wallet to broadcast.
       * This lets us safely recover from wallet-side "broadcast_failed"
       * responses without blindly sending a second deployment.
       */
      const deploymentNonce =
        await publicClient.getTransactionCount({
          address,
          blockTag: 'pending',
        });

      const predictedAddress =
        getContractAddress({
          from: address,
          nonce: BigInt(deploymentNonce),
        });

      /*
       * Estimate deployment gas ourselves before opening MetaMask.
       *
       * Some mobile/injected wallet paths fail to estimate contract
       * creation gas correctly and show a 0 ETH gas fee. Supplying an
       * explicit gas limit avoids relying on the wallet for that step.
       *
       * Add a 20% buffer so the deployment is not right on the estimate.
       */
      let estimatedGas: bigint;

      try {
        const rawEstimate = await publicClient.request({
          method: 'eth_estimateGas',
          params: [
            {
              from: address,
              data: marketplaceBytecode,
            },
          ],
        });

        const rawEstimateHex =
          rawEstimate as `0x${string}`;

        estimatedGas =
          BigInt(rawEstimateHex);
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
        (estimatedGas * 120n + 99n) / 100n;

      const gasHex =
        `0x${gasWithBuffer.toString(16)}` as `0x${string}`;

      let txHash: `0x${string}` | null = null;

      try {
        txHash = await walletClient.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: address,
              data: marketplaceBytecode,
              gas: gasHex,
            },
          ],
        }) as `0x${string}`;
      } catch (walletError) {
        /*
         * A wallet can occasionally report that broadcasting failed
         * after confirmation. Do not immediately retry: the transaction
         * may still have reached Base.
         *
         * Check the deterministic CREATE address first.
         */
        const landed =
          await waitForCodeAtAddress(
            publicClient,
            predictedAddress,
            10,
            2000,
          );

        if (landed) {
          setContractAddress(predictedAddress);
          setDeploying(false);

          void verifyContract(
            predictedAddress,
          );

          return;
        }

        const walletMessage =
          walletError instanceof Error
            ? walletError.message
            : String(walletError);

        throw new Error(
          walletMessage.toLowerCase().includes('service unavailable') ||
          walletMessage.toLowerCase().includes('broadcast_failed')
            ? 'MetaMask could not broadcast the deployment and no contract appeared on Base. No second deployment was sent. Check that MetaMask is on Base Mainnet and try again.'
            : walletMessage,
        );
      }

      setHash(txHash);

      const receipt =
        await publicClient
          .waitForTransactionReceipt(
            {
              hash: txHash,
            },
          );

      if (
        receipt.status !==
        'success'
      ) {
        throw new Error(
          'Deployment transaction reverted.',
        );
      }

      const deployedAddress =
        receipt.contractAddress ??
        predictedAddress;

      /*
       * If a receipt somehow lacks contractAddress, confirm the predicted
       * address actually has code before treating deployment as successful.
       */
      if (!receipt.contractAddress) {
        const hasCode =
          await waitForCodeAtAddress(
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

      setContractAddress(
        deployedAddress,
      );

      setDeploying(false);

      /*
       * Verification runs separately.
       *
       * A BaseScan API issue must never
       * make a successful deployment appear
       * to have failed.
       */
      void verifyContract(
        deployedAddress,
      );
    } catch (deploymentError) {
      const message =
        deploymentError instanceof Error
          ? deploymentError.message
          : 'Deployment failed.';

      setError(message);

      setDeploying(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="mark">
          ▲
        </div>

        <p className="eyebrow">
          TOBYWORLD · BASE
        </p>

        <h1>
          Contract Deployer
        </h1>

        <p className="lede">
          One contract. One
          network. One approval.
        </p>
      </section>

      <section className="card">
        <div className="row strong">
          <span>
            Contract
          </span>

          <b>
            TobyworldMarketplaceV1
          </b>
        </div>

        <div className="row">
          <span>
            Network
          </span>

          <b className="good">
            Base Mainnet · 8453
          </b>
        </div>

        <div className="row">
          <span>
            Marketplace fee
          </span>

          <b>
            1%
          </b>
        </div>

        <div className="row">
          <span>
            Fee recipient
          </span>

          <b>
            {short(
              FEE_RECIPIENT,
            )}
          </b>
        </div>

        <div className="row">
          <span>
            Constructor
          </span>

          <b>
            None
          </b>
        </div>

        <div className="row">
          <span>
            Compiler
          </span>

          <b>
            {
              compilerVersion.split(
                '+',
              )[0]
            }
          </b>
        </div>

        <div className="row">
          <span>
            Verification
          </span>

          <b className="good">
            Automatic
          </b>
        </div>
      </section>

      {!isConnected ? (
        <section className="actions">
          <button
            className="primary"
            disabled={
              !injected ||
              isConnecting
            }
            onClick={() =>
              injected &&
              connect({
                connector:
                  injected,
              })
            }
          >
            {isConnecting
              ? 'Opening MetaMask…'
              : 'Connect MetaMask'}
          </button>

          <p className="hint">
            MetaMask is preferred for deployment.
            Make sure the selected network is Base Mainnet.
          </p>
        </section>
      ) : (
        <section className="actions">
          <div className="walletLine">
            <div>
              <span>
                Connected
              </span>

              <b>
                {short(
                  address,
                )}
              </b>
            </div>

            <button
              className="textButton"
              onClick={() =>
                disconnect()
              }
            >
              Disconnect
            </button>
          </div>

          {!onBase ? (
            <button
              className="primary"
              disabled={
                isSwitching
              }
              onClick={() =>
                switchChainAsync({
                  chainId:
                    base.id,
                })
              }
            >
              {isSwitching
                ? 'Switching…'
                : 'Switch to Base'}
            </button>
          ) : (
            <button
              className="primary deploy"
              disabled={
                deploying
              }
              onClick={
                deploy
              }
            >
              {deploying
                ? 'Deploying…'
                : 'Deploy Marketplace'}
            </button>
          )}
        </section>
      )}

      {hash && (
        <section className="result pending">
          <span>
            Transaction
            submitted
          </span>

          <a
            href={`https://basescan.org/tx/${hash}`}
            target="_blank"
            rel="noreferrer"
          >
            {short(hash)} ↗
          </a>
        </section>
      )}

      {contractAddress && (
        <section className="result success">
          <span>
            Marketplace
            deployed ✓
          </span>

          <strong>
            {
              contractAddress
            }
          </strong>

          <a
            href={`https://basescan.org/address/${contractAddress}`}
            target="_blank"
            rel="noreferrer"
          >
            View contract on
            BaseScan ↗
          </a>
        </section>
      )}

      {contractAddress &&
        verificationState !==
          'idle' && (
          <section
            className={`result ${
              verificationState ===
              'verified'
                ? 'success'
                : verificationState ===
                    'failed'
                  ? 'error'
                  : 'pending'
            }`}
          >
            <span>
              {verificationState ===
              'verified'
                ? 'BaseScan verified ✓'
                : verificationState ===
                    'failed'
                  ? 'Verification needs attention'
                  : 'Verifying source code…'}
            </span>

            {verificationMessage && (
              <p>
                {
                  verificationMessage
                }
              </p>
            )}

            {(verificationState ===
              'failed' ||
              verificationState ===
                'pending') && (
              <button
                className="secondary"
                onClick={
                  retryVerification
                }
              >
                {verificationState ===
                'pending'
                  ? 'Check verification again'
                  : 'Retry verification'}
              </button>
            )}
          </section>
        )}

      {(error ||
        connectError) && (
        <section className="result error">
          <span>
            Couldn’t complete
            deployment
          </span>

          <p>
            {error ??
              connectError?.message}
          </p>
        </section>
      )}

      <section className="safety">
        <b>
          Built-in deployment
          checks
        </b>

        <p>
          The contract rejects
          every chain except Base
          and verifies that SEED,
          both Lore Land
          contracts, USDC and TOBY
          exist before deployment
          completes. Verified
          source is submitted
          automatically after a
          successful deployment.
        </p>
      </section>
    </main>
  );
}