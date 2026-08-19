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
import { marketplaceAbi, marketplaceBytecode, compilerVersion } from '@/lib/marketplace.generated';

const FEE_RECIPIENT = '0x0ba4aB96AFfe0486DeB9a04B9dB53B0c1a65f2d8';

function short(value?: string) {
  if (!value) return '—';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function Deployer() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending: isConnecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: base.id });

  const [deploying, setDeploying] = useState(false);
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [contractAddress, setContractAddress] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onBase = chainId === base.id;
  const coinbase = useMemo(() => connectors.find((c) => c.id === 'coinbaseWalletSDK'), [connectors]);
  const injected = useMemo(() => connectors.find((c) => c.id === 'injected'), [connectors]);

  async function deploy() {
    setError(null);
    setHash(null);
    setContractAddress(null);

    try {
      if (!address || !walletClient || !publicClient) throw new Error('Connect a wallet first.');
      if (chainId !== base.id) await switchChainAsync({ chainId: base.id });

      const accountCode = await publicClient.getBytecode({ address });
      if (accountCode && accountCode !== '0x') {
        throw new Error('This address appears to be a smart-contract wallet. Base smart accounts cannot deploy this contract with normal CREATE. Connect an EOA / legacy wallet instead.');
      }

      const nonce = await publicClient.getTransactionCount({ address, blockTag: 'pending' });
      const predicted = getContractAddress({ from: address, nonce: BigInt(nonce) });

      setDeploying(true);
      const txHash = await walletClient.deployContract({
        abi: marketplaceAbi,
        bytecode: marketplaceBytecode,
        account: address,
        chain: base,
      });
      setHash(txHash);

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error('Deployment transaction reverted.');
      setContractAddress(receipt.contractAddress ?? predicted);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Deployment failed.';
      setError(message);
    } finally {
      setDeploying(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="mark">▲</div>
        <p className="eyebrow">TOBYWORLD · BASE</p>
        <h1>Contract Deployer</h1>
        <p className="lede">One contract. One network. One approval.</p>
      </section>

      <section className="card">
        <div className="row strong"><span>Contract</span><b>TobyworldMarketplaceV1</b></div>
        <div className="row"><span>Network</span><b className="good">Base Mainnet · 8453</b></div>
        <div className="row"><span>Marketplace fee</span><b>1%</b></div>
        <div className="row"><span>Fee recipient</span><b>{short(FEE_RECIPIENT)}</b></div>
        <div className="row"><span>Constructor</span><b>None</b></div>
        <div className="row"><span>Compiler</span><b>{compilerVersion.split('+')[0]}</b></div>
      </section>

      {!isConnected ? (
        <section className="actions">
          <button
            className="primary"
            disabled={!coinbase || isConnecting}
            onClick={() => coinbase && connect({ connector: coinbase })}
          >
            {isConnecting ? 'Opening wallet…' : 'Connect Coinbase / Base legacy wallet'}
          </button>
          {injected && (
            <button className="secondary" disabled={isConnecting} onClick={() => connect({ connector: injected })}>
              Use browser wallet
            </button>
          )}
          <p className="hint">For deployment, use an EOA / legacy wallet. Base Account smart wallets currently cannot deploy with normal CREATE.</p>
        </section>
      ) : (
        <section className="actions">
          <div className="walletLine">
            <div><span>Connected</span><b>{short(address)}</b></div>
            <button className="textButton" onClick={() => disconnect()}>Disconnect</button>
          </div>

          {!onBase ? (
            <button className="primary" disabled={isSwitching} onClick={() => switchChainAsync({ chainId: base.id })}>
              {isSwitching ? 'Switching…' : 'Switch to Base'}
            </button>
          ) : (
            <button className="primary deploy" disabled={deploying} onClick={deploy}>
              {deploying ? 'Deploying…' : 'Deploy Marketplace'}
            </button>
          )}
        </section>
      )}

      {hash && (
        <section className="result pending">
          <span>Transaction submitted</span>
          <a href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noreferrer">{short(hash)} ↗</a>
        </section>
      )}

      {contractAddress && (
        <section className="result success">
          <span>Marketplace deployed ✓</span>
          <strong>{contractAddress}</strong>
          <a href={`https://basescan.org/address/${contractAddress}`} target="_blank" rel="noreferrer">View contract on BaseScan ↗</a>
        </section>
      )}

      {(error || connectError) && (
        <section className="result error">
          <span>Couldn’t complete deployment</span>
          <p>{error ?? connectError?.message}</p>
        </section>
      )}

      <section className="safety">
        <b>Built-in deployment checks</b>
        <p>The contract itself rejects every chain except Base and verifies that SEED, both Lore Land contracts, USDC and TOBY exist before deployment completes.</p>
      </section>
    </main>
  );
}
