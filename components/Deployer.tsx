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

  const coinbase =
    useMemo(
      () =>
        connectors.find(
          (connector) =>
            connector.id === 'coinbaseWalletSDK',
        ),
      [connectors],
    );

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
      const txHash = await walletClient.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: address,
            data: marketplaceBytecode,
          },
        ],
      }) as `0x${string}`;

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

      if (
        !receipt.contractAddress
      ) {
        throw new Error(
          'Deployment succeeded but no contract address was returned.',
        );
      }

      const deployedAddress =
        receipt.contractAddress;

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
              !coinbase ||
              isConnecting
            }
            onClick={() =>
              coinbase &&
              connect({
                connector:
                  coinbase,
              })
            }
          >
            {isConnecting
              ? 'Opening wallet…'
              : 'Connect Coinbase / Base wallet'}
          </button>

          {injected && (
            <button
              className="secondary"
              disabled={
                isConnecting
              }
              onClick={() =>
                connect({
                  connector:
                    injected,
                })
              }
            >
              Use browser wallet
            </button>
          )}

          <p className="hint">
            Connect your wallet and approve
            the Base deployment transaction.
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