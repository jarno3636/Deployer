"use client";

import { useEffect, useMemo, useState } from "react";
import { encodeAbiParameters, encodeDeployData, getAddress, getContractAddress, isAddress } from "viem";
import { useAccount, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { arc, ARC_RPC_URLS } from "../lib/arc";
import { cctpBridgeAbi, cctpBridgeBytecode, cctpBridgeCompilerVersion } from "../lib/scanarc-cctp-bridge.generated";
import { CCTP_MAINNET_CHAINS, CCTP_V2 } from "../lib/cctp-mainnet";

const OWNER = getAddress("0x25BE27a17580F59206061B8823E3c0FbC1F7c52E");
const FEE_RECIPIENT = OWNER;
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const UNISWAP_UNIVERSAL_ROUTER = getAddress("0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1");
const UNISWAP_PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const UNISWAP_V4_QUOTER = getAddress("0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94");
const UNISWAP_POOL_MANAGER = getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951");
const SCANARC_ARCFUN_V5 = getAddress("0x2E42f2daE317be31F8859ff000efaFD67dbb245F");
const EXISTING_ARC_WIDE_ROUTER = getAddress("0x303c8889930187a7b11280292055dd1364552d29");
const BRIDGE_STORAGE_KEY = "scanarc-cctp-bridge:arc-mainnet:v1";
const ARC_CCTP_DOMAIN = 26;
const DESTINATION_DOMAINS = CCTP_MAINNET_CHAINS.filter((c) => c.domain !== ARC_CCTP_DOMAIN).map((c) => c.domain);

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function explorerAddress(address: string) { return `${arc.blockExplorers.default.url}/address/${address}`; }
function explorerTx(hash: string) { return `${arc.blockExplorers.default.url}/tx/${hash}`; }

export function Deployer() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync, reset: resetConnect, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { data: walletClient } = useWalletClient({ chainId: arc.id });
  const publicClient = usePublicClient({ chainId: arc.id });
  const injected = useMemo(() => connectors.find((connector) => connector.id === "injected"), [connectors]);

  const [walletOpening, setWalletOpening] = useState(false);
  const [bridgeRiskAccepted, setBridgeRiskAccepted] = useState(false);
  const [bridgeDeploying, setBridgeDeploying] = useState(false);
  const [bridgeHash, setBridgeHash] = useState<`0x${string}` | null>(null);
  const [bridgeAddress, setBridgeAddress] = useState<`0x${string}` | null>(null);
  const [bridgeVerifyState, setBridgeVerifyState] = useState<"idle" | "submitting" | "submitted" | "error">("idle");
  const [bridgeVerifyMessage, setBridgeVerifyMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onArc = chainId === arc.id;
  const correctOwner = address?.toLowerCase() === OWNER.toLowerCase();

  useEffect(() => {
    try {
      const saved = localStorage.getItem(BRIDGE_STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as { address?: string; hash?: `0x${string}` };
      if (parsed.address && isAddress(parsed.address)) setBridgeAddress(getAddress(parsed.address));
      if (parsed.hash) setBridgeHash(parsed.hash);
    } catch {}
  }, []);

  async function waitForCode(target: `0x${string}`) {
    if (!publicClient) return false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = await publicClient.getBytecode({ address: target });
      if (code && code !== "0x") return true;
      await sleep(1800);
    }
    return false;
  }

  async function connectOwnerWallet() {
    if (!injected || walletOpening) return;
    setError(null);
    setWalletOpening(true);
    resetConnect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connectAsync({ connector: injected }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("WALLET_CONNECT_TIMEOUT")), 15_000);
        }),
      ]);
    } catch (cause) {
      // Some iOS wallet browsers grant the permission but fail to resolve the
      // original EIP-1193 request. If permission was granted, a reload lets
      // Wagmi hydrate the now-authorized account instead of leaving the UI stuck.
      const ethereum = (window as any).ethereum;
      if (cause instanceof Error && cause.message === "WALLET_CONNECT_TIMEOUT" && ethereum?.request) {
        try {
          const accounts = await ethereum.request({ method: "eth_accounts" }) as string[];
          if (Array.isArray(accounts) && accounts.length > 0) {
            window.location.reload();
            return;
          }
        } catch {}
        setError("Wallet permission did not return to ScanArc. Return to this page and tap Connect wallet again.");
        return;
      }
      setError(cause instanceof Error ? cause.message : "Wallet connection failed.");
    } finally {
      if (timer) clearTimeout(timer);
      resetConnect();
      setWalletOpening(false);
    }
  }

  async function repairWalletArcNetwork() {
    setError(null);
    try {
      if (!walletClient) throw new Error("Connect your wallet first.");
      await walletClient.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x13b2", chainName: "Arc", nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 }, rpcUrls: [...ARC_RPC_URLS], blockExplorerUrls: [arc.blockExplorers.default.url] }] } as any);
      await switchChainAsync({ chainId: arc.id });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Wallet network repair was not accepted."); }
  }

  function bridgeConstructorArgs() {
    return [OWNER, FEE_RECIPIENT, ARC_USDC, CCTP_V2.tokenMessengerV2, ARC_CCTP_DOMAIN, DESTINATION_DOMAINS] as const;
  }

  async function validateBridge(target: `0x${string}`) {
    if (!publicClient) throw new Error("Arc RPC is unavailable.");
    const read = (functionName: string, args?: readonly unknown[]) => publicClient.readContract({ address: target, abi: cctpBridgeAbi, functionName, args } as any);
    const [owner, recipient, fee, usdc, messenger, localDomain] = await Promise.all([
      read("owner"), read("feeRecipient"), read("FEE_BPS"), read("USDC"), read("TOKEN_MESSENGER_V2"), read("LOCAL_DOMAIN"),
    ]);
    if (String(owner).toLowerCase() !== OWNER.toLowerCase()) throw new Error("Bridge owner validation failed.");
    if (String(recipient).toLowerCase() !== FEE_RECIPIENT.toLowerCase()) throw new Error("Bridge fee recipient validation failed.");
    if (BigInt(String(fee)) !== 25n) throw new Error("Bridge fee validation failed. Expected fixed 25 bps.");
    if (String(usdc).toLowerCase() !== ARC_USDC.toLowerCase()) throw new Error("Bridge Arc USDC validation failed.");
    if (String(messenger).toLowerCase() !== CCTP_V2.tokenMessengerV2.toLowerCase()) throw new Error("Circle TokenMessengerV2 validation failed.");
    if (Number(localDomain) !== ARC_CCTP_DOMAIN) throw new Error("Arc CCTP domain validation failed.");
    for (const domain of DESTINATION_DOMAINS) {
      const enabled = await read("destinationEnabled", [domain]);
      if (enabled !== true) throw new Error(`CCTP destination domain ${domain} is not enabled.`);
    }
    const localEnabled = await read("destinationEnabled", [ARC_CCTP_DOMAIN]);
    if (localEnabled === true) throw new Error("Local Arc domain must not be enabled as a destination.");
  }
  async function deployCctpBridge() {
    setError(null);
    try {
      if (!address || !publicClient) throw new Error("Connect the owner wallet first.");
      if (!correctOwner) throw new Error(`Wrong wallet. Connect ${OWNER}.`);
      if (!bridgeRiskAccepted) throw new Error("Confirm the CCTP bridge safety gate first.");
      if (!onArc) { await switchChainAsync({ chainId: arc.id }); await sleep(700); }
      if (!walletClient) throw new Error("Wallet is not ready on Arc.");
      setBridgeDeploying(true); setBridgeHash(null); setBridgeAddress(null);
      localStorage.removeItem(BRIDGE_STORAGE_KEY);

      const data = encodeDeployData({ abi: cctpBridgeAbi, bytecode: cctpBridgeBytecode, args: bridgeConstructorArgs() as any });
      const nonce = await publicClient.getTransactionCount({ address, blockTag: "pending" });
      const predictedAddress = getContractAddress({ from: address, nonce: BigInt(nonce) });
      const txHash = await walletClient.sendTransaction({ account: address, chain: arc, data, gas: 2_500_000n });
      setBridgeHash(txHash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error("CCTP bridge deployment reverted.");
      const deployed = receipt.contractAddress ?? predictedAddress;
      if (!(await waitForCode(deployed))) throw new Error("CCTP bridge bytecode was not found after confirmation.");
      await validateBridge(deployed);
      setBridgeAddress(deployed);
      localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ address: deployed, hash: txHash }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "CCTP bridge deployment failed."); }
    finally { setBridgeDeploying(false); }
  }

  async function verifyCctpBridge() {
    setError(null); setBridgeVerifyState("submitting"); setBridgeVerifyMessage(null);
    try {
      if (!bridgeAddress) throw new Error("Deploy the CCTP bridge first.");
      const encoded = encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint32" }, { type: "uint32[]" }],
        bridgeConstructorArgs() as any,
      );
      const res = await fetch("/api/blockscout/verify-bridge", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: bridgeAddress, constructorArguments: encoded.slice(2) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "CCTP bridge verification failed.");
      setBridgeVerifyState("submitted"); setBridgeVerifyMessage(json?.message || "CCTP bridge verification submitted.");
    } catch (cause) { setBridgeVerifyState("error"); setError(cause instanceof Error ? cause.message : "Bridge verification failed."); }
  }

  function clearSavedBridge() {
    localStorage.removeItem(BRIDGE_STORAGE_KEY); setBridgeHash(null); setBridgeAddress(null); setBridgeVerifyState("idle"); setError(null);
  }

  return <main className="shell">
    <header className="hero"><div className="brandRow"><div className="mark">A</div><div><div className="eyebrow">SCANARC · ARC MAINNET</div><div className="networkPill"><i /> Arc 5042</div></div></div><h1>ScanArc CCTP Bridge V1</h1><p>Deploy only the missing Arc CCTP execution adapter. Existing ScanArc routers remain untouched.</p></header>
    <section className="statusGrid"><article><span>BRIDGE FEE</span><b>0.25%</b><small>Fixed at 25 bps</small></article><article><span>BRIDGE</span><b>CCTP V2</b><small>Native USDC</small></article><article><span>DEPLOYMENTS</span><b>1 NEW</b><small>No registry transaction</small></article><article><span>EXISTING ROUTERS</span><b>KEEP</b><small>No redeployment</small></article></section>

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">01</span><div><h2>Connect owner</h2><p>Use the existing ScanArc owner wallet on Arc.</p></div></div>
      {!isConnected ? <button className="primary" disabled={!injected || walletOpening} onClick={connectOwnerWallet}>{walletOpening ? "Opening wallet…" : "Connect wallet"}</button> : <div className="walletBox"><div><span>CONNECTED WALLET</span><b className={correctOwner ? "good" : "bad"}>{address}</b></div><button className="ghost compact" onClick={() => disconnect()}>Disconnect</button></div>}
      {isConnected && !correctOwner && <div className="notice danger">Wrong wallet. Connect <code>{OWNER}</code>.</div>}
      {isConnected && correctOwner && !onArc && <button className="primary" disabled={isSwitching} onClick={() => switchChainAsync({ chainId: arc.id })}>{isSwitching ? "Switching…" : "Switch to Arc Mainnet"}</button>}
      {isConnected && correctOwner && onArc && <div className="notice success">✓ Approved owner connected on Arc.</div>}
      <button className="secondary" disabled={!isConnected} onClick={repairWalletArcNetwork}>Repair Arc network in wallet</button>
    </section>

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">02</span><div><h2>Preserve existing ScanArc contracts</h2><p>This deployer will not redeploy or replace the routers already implemented.</p></div></div>
      <div className="details"><div><span>Existing Arcfun V5</span><code>{SCANARC_ARCFUN_V5}</code></div><div><span>Existing Arc-Wide Router V1</span><code>{EXISTING_ARC_WIDE_ROUTER}</code></div><div><span>Action</span><strong>Leave both unchanged</strong></div></div>
    </section>

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">03</span><div><h2>Deploy CCTP Bridge V1</h2><p>One Arc deployment. Destination domains are encoded in the constructor, so there is no registry deployment and no follow-up configuration transaction.</p></div></div>
      <div className="details"><div><span>Arc native USDC</span><code>{ARC_USDC}</code></div><div><span>Circle TokenMessengerV2</span><code>{CCTP_V2.tokenMessengerV2}</code></div><div><span>Local CCTP domain</span><strong>26 · Arc</strong></div><div><span>Destination networks</span><strong>{CCTP_MAINNET_CHAINS.filter((c) => c.domain !== ARC_CCTP_DOMAIN).map((c) => c.name).join(" · ")}</strong></div><div><span>ScanArc fee</span><strong>0.25% · immutable constant</strong></div><div><span>Fee recipient</span><code>{FEE_RECIPIENT}</code></div></div>
      <label className="check"><input type="checkbox" checked={bridgeRiskAccepted} onChange={(e) => setBridgeRiskAccepted(e.target.checked)} /><span>I understand this deploys the Arc source-chain CCTP execution adapter. It takes the fixed 0.25% ScanArc fee, burns the remainder through Circle CCTP V2, and does not intentionally retain user USDC.</span></label>
      {!bridgeAddress ? <button className="primary deploy" disabled={!isConnected || !correctOwner || !onArc || !bridgeRiskAccepted || bridgeDeploying} onClick={deployCctpBridge}>{bridgeDeploying ? "Deploying CCTP Bridge V1…" : "Deploy CCTP Bridge V1"}</button> : <div className="notice success strong">✓ CCTP Bridge V1 deployed and on-chain settings validated.</div>}
      {bridgeHash && <a className="linkButton" href={explorerTx(bridgeHash)} target="_blank" rel="noreferrer">View bridge deployment ↗</a>}
    </section>

    {bridgeAddress && <section className="card stepCard"><div className="stepHead"><span className="stepNo">04</span><div><h2>Verify CCTP Bridge V1</h2><p>Publishes the exact execution contract source and exact constructor arguments to Blockscout.</p></div></div><div className="contractBox"><span>DEPLOYED CCTP BRIDGE</span><strong>{bridgeAddress}</strong></div><div className="verifyMeta"><span>{cctpBridgeCompilerVersion}</span><span>Optimizer 200</span><span>FEE 25 BPS</span></div><button className="secondary" disabled={bridgeVerifyState === "submitting"} onClick={verifyCctpBridge}>{bridgeVerifyState === "submitting" ? "Submitting verification…" : "Verify CCTP Bridge V1"}</button>{bridgeVerifyState === "submitted" && <div className="notice success">✓ {bridgeVerifyMessage}</div>}<a className="linkButton" href={explorerAddress(bridgeAddress)} target="_blank" rel="noreferrer">Open bridge on Arc Explorer ↗</a></section>}

    {(error || connectError) && <section className="card error"><b>Stopped safely</b><p>{error ?? connectError?.message}</p></section>}
    {bridgeAddress && <button className="ghost reset" onClick={clearSavedBridge}>Clear saved bridge deployment from this browser</button>}
    <footer>This deploys only the Arc source adapter. Supporting fee-enforced bridging initiated from another source chain requires the same adapter to exist on that source chain; this Arc deployment alone does not create those additional source-chain contracts.</footer>
  </main>;
}
