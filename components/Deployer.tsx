"use client";

import { useEffect, useMemo, useState } from "react";
import { encodeAbiParameters, encodeDeployData, getAddress, getContractAddress, isAddress } from "viem";
import { useAccount, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { arc, ARC_RPC_URLS } from "../lib/arc";
import { routerAbi, routerBytecode, compilerVersion } from "../lib/scanarc-router.generated";
import { bridgeRegistryAbi, bridgeRegistryBytecode, bridgeRegistryCompilerVersion } from "../lib/scanarc-bridge.generated";
import { CCTP_MAINNET_CHAINS, CCTP_PENDING_DOMAINS, CCTP_V2 } from "../lib/cctp-mainnet";

const OWNER = getAddress("0x25BE27a17580F59206061B8823E3c0FbC1F7c52E");
const FEE_RECIPIENT = OWNER;
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const UNISWAP_UNIVERSAL_ROUTER = getAddress("0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1");
const UNISWAP_PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const UNISWAP_V4_QUOTER = getAddress("0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94");
const UNISWAP_POOL_MANAGER = getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951");
const SCANARC_ARCFUN_V5 = getAddress("0x2E42f2daE317be31F8859ff000efaFD67dbb245F");
const STORAGE_KEY = "scanarc-universal-router:arc-mainnet:v1";
const BRIDGE_STORAGE_KEY = "scanarc-bridge-registry:arc-mainnet:v1";

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
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [contractAddress, setContractAddress] = useState<`0x${string}` | null>(null);
  const [infraOk, setInfraOk] = useState(false);
  const [checkingInfra, setCheckingInfra] = useState(false);
  const [verifyState, setVerifyState] = useState<"idle" | "submitting" | "submitted" | "error">("idle");
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bridgeRiskAccepted, setBridgeRiskAccepted] = useState(false);
  const [bridgeDeploying, setBridgeDeploying] = useState(false);
  const [bridgeHash, setBridgeHash] = useState<`0x${string}` | null>(null);
  const [bridgeConfigHash, setBridgeConfigHash] = useState<`0x${string}` | null>(null);
  const [bridgeAddress, setBridgeAddress] = useState<`0x${string}` | null>(null);
  const [bridgeConfigured, setBridgeConfigured] = useState(false);
  const [bridgeVerifyState, setBridgeVerifyState] = useState<"idle" | "submitting" | "submitted" | "error">("idle");
  const [bridgeVerifyMessage, setBridgeVerifyMessage] = useState<string | null>(null);

  const onArc = chainId === arc.id;
  const correctOwner = address?.toLowerCase() === OWNER.toLowerCase();

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as { address?: string; hash?: `0x${string}` };
      if (parsed.address && isAddress(parsed.address)) setContractAddress(getAddress(parsed.address));
      if (parsed.hash) setHash(parsed.hash);
      const bridgeSaved = localStorage.getItem(BRIDGE_STORAGE_KEY);
      if (bridgeSaved) {
        const bridgeParsed = JSON.parse(bridgeSaved) as { address?: string; hash?: `0x${string}`; configHash?: `0x${string}`; configured?: boolean };
        if (bridgeParsed.address && isAddress(bridgeParsed.address)) setBridgeAddress(getAddress(bridgeParsed.address));
        if (bridgeParsed.hash) setBridgeHash(bridgeParsed.hash);
        if (bridgeParsed.configHash) setBridgeConfigHash(bridgeParsed.configHash);
        if (bridgeParsed.configured) setBridgeConfigured(true);
      }
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

  async function checkInfrastructure() {
    setError(null); setCheckingInfra(true);
    try {
      if (!publicClient) throw new Error("Arc RPC is unavailable.");
      const addresses = [ARC_USDC, UNISWAP_UNIVERSAL_ROUTER, UNISWAP_PERMIT2, UNISWAP_V4_QUOTER, UNISWAP_POOL_MANAGER] as const;
      const codes = await Promise.all(addresses.map((target) => publicClient.getBytecode({ address: target })));
      if (!codes.every((code) => Boolean(code && code !== "0x"))) throw new Error("One or more official Arc/Uniswap contracts have no bytecode.");
      setInfraOk(true);
    } catch (cause) {
      setInfraOk(false);
      setError(cause instanceof Error ? cause.message : "Infrastructure check failed.");
    } finally { setCheckingInfra(false); }
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

  function constructorArgs() {
    return [ARC_USDC, UNISWAP_UNIVERSAL_ROUTER, UNISWAP_PERMIT2, FEE_RECIPIENT, OWNER] as const;
  }

  async function validateRouter(target: `0x${string}`) {
    if (!publicClient) throw new Error("Arc RPC is unavailable.");
    const read = (functionName: string) => publicClient.readContract({ address: target, abi: routerAbi, functionName } as any);
    const [owner, recipient, fee, usdc, universalRouter, permit2, pendingOwner] = await Promise.all([
      read("owner"), read("feeRecipient"), read("FEE_BPS"), read("usdc"), read("universalRouter"), read("permit2"), read("pendingOwner"),
    ]);
    if (String(owner).toLowerCase() !== OWNER.toLowerCase()) throw new Error("Owner validation failed.");
    if (String(recipient).toLowerCase() !== FEE_RECIPIENT.toLowerCase()) throw new Error("Fee recipient validation failed.");
    if (BigInt(String(fee)) !== 25n) throw new Error("Fee validation failed. Expected 25 bps.");
    if (String(usdc).toLowerCase() !== ARC_USDC.toLowerCase()) throw new Error("Arc USDC validation failed.");
    if (String(universalRouter).toLowerCase() !== UNISWAP_UNIVERSAL_ROUTER.toLowerCase()) throw new Error("Uniswap Universal Router validation failed.");
    if (String(permit2).toLowerCase() !== UNISWAP_PERMIT2.toLowerCase()) throw new Error("Permit2 validation failed.");
    if (String(pendingOwner).toLowerCase() !== "0x0000000000000000000000000000000000000000") throw new Error("Unexpected pending owner detected.");
  }

  async function deploy() {
    setError(null);
    try {
      if (!address || !publicClient) throw new Error("Connect the owner wallet first.");
      if (!correctOwner) throw new Error(`Wrong wallet. Connect ${OWNER}.`);
      if (!riskAccepted) throw new Error("Confirm the deployment safety gate first.");
      if (!infraOk) throw new Error("Run the official infrastructure check first.");
      if (!onArc) { await switchChainAsync({ chainId: arc.id }); await sleep(700); }
      if (!walletClient) throw new Error("Wallet is not ready on Arc.");
      setDeploying(true); setHash(null); setContractAddress(null); localStorage.removeItem(STORAGE_KEY);

      const data = encodeDeployData({ abi: routerAbi, bytecode: routerBytecode, args: constructorArgs() as any });
      const nonce = await publicClient.getTransactionCount({ address, blockTag: "pending" });
      const predictedAddress = getContractAddress({ from: address, nonce: BigInt(nonce) });
      const gas = 3_000_000n;
      let txHash: `0x${string}`;
      try {
        txHash = await walletClient.sendTransaction({ account: address, chain: arc, data, gas });
      } catch (walletError) {
        if (await waitForCode(predictedAddress)) {
          await validateRouter(predictedAddress);
          setContractAddress(predictedAddress);
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ address: predictedAddress }));
          return;
        }
        throw walletError;
      }

      setHash(txHash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error("Deployment reverted.");
      const deployed = receipt.contractAddress ?? predictedAddress;
      if (!(await waitForCode(deployed))) throw new Error("Transaction confirmed, but router bytecode was not found.");
      await validateRouter(deployed);
      setContractAddress(deployed);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ address: deployed, hash: txHash }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Deployment failed."); }
    finally { setDeploying(false); }
  }

  async function verifySource() {
    setError(null); setVerifyState("submitting"); setVerifyMessage(null);
    try {
      if (!contractAddress) throw new Error("Deploy the Arc-wide router first.");
      const encoded = encodeAbiParameters(
        [{type:"address"},{type:"address"},{type:"address"},{type:"address"},{type:"address"}],
        constructorArgs() as any,
      );
      const res = await fetch("/api/blockscout/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: contractAddress, constructorArguments: encoded.slice(2) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Blockscout verification failed.");
      setVerifyState("submitted"); setVerifyMessage(json?.message || "Verification submitted to Blockscout.");
    } catch (cause) { setVerifyState("error"); setError(cause instanceof Error ? cause.message : "Verification failed."); }
  }

  async function deployBridgeRegistry() {
    setError(null);
    try {
      if (!address || !publicClient) throw new Error("Connect the owner wallet first.");
      if (!correctOwner) throw new Error(`Wrong wallet. Connect ${OWNER}.`);
      if (!bridgeRiskAccepted) throw new Error("Confirm the bridge registry safety gate first.");
      if (!onArc) { await switchChainAsync({ chainId: arc.id }); await sleep(700); }
      if (!walletClient) throw new Error("Wallet is not ready on Arc.");
      setBridgeDeploying(true); setBridgeHash(null); setBridgeConfigHash(null); setBridgeAddress(null); setBridgeConfigured(false);
      localStorage.removeItem(BRIDGE_STORAGE_KEY);

      const data = encodeDeployData({ abi: bridgeRegistryAbi, bytecode: bridgeRegistryBytecode, args: [OWNER] });
      const nonce = await publicClient.getTransactionCount({ address, blockTag: "pending" });
      const predictedAddress = getContractAddress({ from: address, nonce: BigInt(nonce) });
      const txHash = await walletClient.sendTransaction({ account: address, chain: arc, data, gas: 1_500_000n });
      setBridgeHash(txHash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error("Bridge registry deployment reverted.");
      const deployed = receipt.contractAddress ?? predictedAddress;
      if (!(await waitForCode(deployed))) throw new Error("Bridge registry bytecode was not found after confirmation.");
      const deployedOwner = await publicClient.readContract({ address: deployed, abi: bridgeRegistryAbi, functionName: "owner" });
      if (String(deployedOwner).toLowerCase() !== OWNER.toLowerCase()) throw new Error("Bridge registry owner validation failed.");
      setBridgeAddress(deployed);

      const configs = CCTP_MAINNET_CHAINS.map((c) => ({
        chainId: c.chainId, cctpDomain: c.domain, usdc: c.usdc,
        tokenMessengerV2: CCTP_V2.tokenMessengerV2,
        messageTransmitterV2: CCTP_V2.messageTransmitterV2,
        enabled: c.enabled,
      }));
      const configTx = await walletClient.writeContract({ account: address, chain: arc, address: deployed, abi: bridgeRegistryAbi, functionName: "configureChains", args: [configs] });
      setBridgeConfigHash(configTx);
      const configReceipt = await publicClient.waitForTransactionReceipt({ hash: configTx });
      if (configReceipt.status !== "success") throw new Error("Bridge registry configuration reverted.");
      const ids = await publicClient.readContract({ address: deployed, abi: bridgeRegistryAbi, functionName: "getChainIds" });
      if (ids.length !== CCTP_MAINNET_CHAINS.length) throw new Error("Bridge registry chain-count validation failed.");
      setBridgeConfigured(true);
      localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ address: deployed, hash: txHash, configHash: configTx, configured: true }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Bridge registry deployment failed."); }
    finally { setBridgeDeploying(false); }
  }

  async function verifyBridgeRegistry() {
    setError(null); setBridgeVerifyState("submitting"); setBridgeVerifyMessage(null);
    try {
      if (!bridgeAddress) throw new Error("Deploy the bridge registry first.");
      const encoded = encodeAbiParameters([{ type: "address" }], [OWNER]);
      const res = await fetch("/api/blockscout/verify-bridge", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: bridgeAddress, constructorArguments: encoded.slice(2) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Bridge registry verification failed.");
      setBridgeVerifyState("submitted"); setBridgeVerifyMessage(json?.message || "Bridge registry verification submitted.");
    } catch (cause) { setBridgeVerifyState("error"); setError(cause instanceof Error ? cause.message : "Bridge verification failed."); }
  }

  function clearSavedRouter() {
    localStorage.removeItem(STORAGE_KEY); setHash(null); setContractAddress(null); setVerifyState("idle"); setError(null);
  }

  const deployReady = Boolean(isConnected && correctOwner && onArc && infraOk && riskAccepted && !deploying);

  return <main className="shell">
    <header className="hero"><div className="brandRow"><div className="mark">A</div><div><div className="eyebrow">SCANARC · ARC MAINNET</div><div className="networkPill"><i /> Arc 5042</div></div></div><h1>Arc-Wide Router V1</h1><p>Add official Uniswap v4 liquidity to ScanArc without weakening the Arcfun router you already deployed.</p></header>
    <section className="statusGrid"><article><span>SCANARC FEE</span><b>0.25%</b><small>Always collected in USDC</small></article><article><span>DEX</span><b>UNISWAP V4</b><small>Official Arc deployment</small></article><article><span>ROUTES</span><b>1–4 HOPS</b><small>Exact-input only</small></article><article><span>ARCFUN</span><b>V5 STAYS</b><small>Lifecycle route remains separate</small></article></section>

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">01</span><div><h2>Connect owner</h2><p>Use the same ScanArc owner wallet on Arc.</p></div></div>
      {!isConnected ? <button className="primary" disabled={!injected || walletOpening} onClick={connectOwnerWallet}>{walletOpening ? "Opening wallet…" : "Connect wallet"}</button> : <div className="walletBox"><div><span>CONNECTED WALLET</span><b className={correctOwner ? "good" : "bad"}>{address}</b></div><button className="ghost compact" onClick={() => disconnect()}>Disconnect</button></div>}
      {isConnected && !correctOwner && <div className="notice danger">Wrong wallet. Connect <code>{OWNER}</code>.</div>}
      {isConnected && correctOwner && !onArc && <button className="primary" disabled={isSwitching} onClick={() => switchChainAsync({ chainId: arc.id })}>{isSwitching ? "Switching…" : "Switch to Arc Mainnet"}</button>}
      {isConnected && correctOwner && onArc && <div className="notice success">✓ Approved owner connected on Arc.</div>}
      <button className="secondary" disabled={!isConnected} onClick={repairWalletArcNetwork}>Repair Arc network in wallet</button>
    </section>

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">02</span><div><h2>Check official Arc liquidity infrastructure</h2><p>The router is locked to Uniswap's official Arc Universal Router and Permit2. It cannot call arbitrary swap targets.</p></div></div>
      <div className="details"><div><span>Arc USDC</span><code>{ARC_USDC}</code></div><div><span>Universal Router</span><code>{UNISWAP_UNIVERSAL_ROUTER}</code></div><div><span>Permit2</span><code>{UNISWAP_PERMIT2}</code></div><div><span>V4 Quoter</span><code>{UNISWAP_V4_QUOTER}</code></div><div><span>Pool Manager</span><code>{UNISWAP_POOL_MANAGER}</code></div></div>
      <button className="secondary" disabled={!onArc || checkingInfra} onClick={checkInfrastructure}>{checkingInfra ? "Checking Arc…" : "Check official contracts"}</button>
      {infraOk && <div className="notice success strong">✓ All required official contracts have bytecode on Arc.</div>}
    </section>

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">03</span><div><h2>Keep Arcfun V5</h2><p>This new contract complements your existing lifecycle router. Do not replace it.</p></div></div>
      <div className="details"><div><span>Existing Arcfun V5</span><code>{SCANARC_ARCFUN_V5}</code></div><div><span>Use V5 for</span><strong>Bonding curves + Arcfun graduated routes</strong></div><div><span>Use this router for</span><strong>Other Arc tokens with Uniswap v4 liquidity</strong></div></div>
    </section>

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">04</span><div><h2>Deploy Arc-Wide Router V1</h2><p>Supports ERC-20 ↔ USDC single-hop and multi-hop Uniswap v4 routes. ScanArc's fee remains 0.25% and is always paid in USDC.</p></div></div>
      <label className="check"><input type="checkbox" checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)} /><span>I understand this expands ScanArc to Uniswap v4 liquidity. Route discovery and quoting still need to validate pools before users trade. This is production-oriented beta code, not an independent audit.</span></label>
      {!contractAddress ? <button className="primary deploy" disabled={!deployReady} onClick={deploy}>{deploying ? "Deploying Arc-Wide Router…" : "Deploy Arc-Wide Router V1"}</button> : <div className="notice success strong">✓ Arc-Wide Router V1 deployed and immutable settings validated.</div>}
      {hash && <a className="linkButton" href={explorerTx(hash)} target="_blank" rel="noreferrer">View deployment transaction ↗</a>}
    </section>

    {contractAddress && <section className="card stepCard"><div className="stepHead"><span className="stepNo">05</span><div><h2>Verify on Blockscout</h2><p>Uses your existing BLOCKSCOUT_API_KEY with the exact viaIR build.</p></div></div><div className="contractBox"><span>DEPLOYED ARC-WIDE ROUTER</span><strong>{contractAddress}</strong></div><div className="verifyMeta"><span>{compilerVersion}</span><span>viaIR ON</span><span>Optimizer 200</span></div><button className="secondary" disabled={verifyState === "submitting"} onClick={verifySource}>{verifyState === "submitting" ? "Submitting verification…" : "Verify with Blockscout"}</button>{verifyState === "submitted" && <div className="notice success">✓ {verifyMessage}</div>}<a className="linkButton" href={explorerAddress(contractAddress)} target="_blank" rel="noreferrer">Open on Arc Explorer ↗</a></section>}

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">06</span><div><h2>Production routing model</h2><p>Your ScanArc backend chooses the appropriate trusted path; users still see one clean swapper.</p></div></div><div className="details"><div><span>Arcfun bonding token</span><strong>Existing ScanArc V5</strong></div><div><span>Arcfun graduated token</span><strong>Existing ScanArc V5</strong></div><div><span>Other Arc token with V4 liquidity</span><strong>Arc-Wide Router V1</strong></div><div><span>No verified/liquid route</span><strong>Do not offer a swap</strong></div></div></section>

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">07</span><div><h2>Deploy CCTP Bridge Registry V1</h2><p>Non-custodial safety registry for ScanArc bridging. User USDC goes directly to Circle CCTP V2; this contract has no token transfer, approval, burn, mint, or withdrawal functions.</p></div></div>
      <div className="details"><div><span>Circle TokenMessengerV2</span><code>{CCTP_V2.tokenMessengerV2}</code></div><div><span>Circle MessageTransmitterV2</span><code>{CCTP_V2.messageTransmitterV2}</code></div><div><span>Enabled at deployment</span><strong>{CCTP_MAINNET_CHAINS.map((c) => c.name).join(" · ")}</strong></div><div><span>Held disabled pending native-USDC verification</span><strong>{CCTP_PENDING_DOMAINS.map((c) => c.name).join(" · ")}</strong></div></div>
      <label className="check"><input type="checkbox" checked={bridgeRiskAccepted} onChange={(e) => setBridgeRiskAccepted(e.target.checked)} /><span>I understand this deploys only a route safety registry. ScanArc must use exact USDC approval to Circle TokenMessengerV2, wait for approval confirmation, then burn through Circle and confirm destination mint/arrival before marking a bridge complete.</span></label>
      {!bridgeAddress ? <button className="primary deploy" disabled={!isConnected || !correctOwner || !onArc || !bridgeRiskAccepted || bridgeDeploying} onClick={deployBridgeRegistry}>{bridgeDeploying ? "Deploying + configuring registry…" : "Deploy CCTP Bridge Registry V1"}</button> : <div className="notice success strong">✓ Bridge registry deployed{bridgeConfigured ? " and 7 verified routes configured." : "."}</div>}
      {bridgeHash && <a className="linkButton" href={explorerTx(bridgeHash)} target="_blank" rel="noreferrer">View registry deployment ↗</a>}
      {bridgeConfigHash && <a className="linkButton" href={explorerTx(bridgeConfigHash)} target="_blank" rel="noreferrer">View route configuration ↗</a>}
    </section>

    {bridgeAddress && <section className="card stepCard"><div className="stepHead"><span className="stepNo">08</span><div><h2>Verify bridge registry</h2><p>Publishes the exact ScanArcBridgeRegistryV1 source and constructor owner to Blockscout.</p></div></div><div className="contractBox"><span>DEPLOYED BRIDGE REGISTRY</span><strong>{bridgeAddress}</strong></div><div className="verifyMeta"><span>{bridgeRegistryCompilerVersion}</span><span>Optimizer 200</span><span>NO CUSTODY</span></div><button className="secondary" disabled={bridgeVerifyState === "submitting"} onClick={verifyBridgeRegistry}>{bridgeVerifyState === "submitting" ? "Submitting verification…" : "Verify bridge registry"}</button>{bridgeVerifyState === "submitted" && <div className="notice success">✓ {bridgeVerifyMessage}</div>}<a className="linkButton" href={explorerAddress(bridgeAddress)} target="_blank" rel="noreferrer">Open registry on Arc Explorer ↗</a></section>}

    {(error || connectError) && <section className="card error"><b>Stopped safely</b><p>{error ?? connectError?.message}</p></section>}
    {contractAddress && <button className="ghost reset" onClick={clearSavedRouter}>Clear saved deployment from this browser</button>}
    <footer>Start with very small live swaps and verify actual balance changes before enabling public Arc-wide trading.</footer>
  </main>;
}
