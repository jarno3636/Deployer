"use client";

import { useEffect, useMemo, useState } from "react";
import { encodeAbiParameters, encodeDeployData, getAddress, getContractAddress, isAddress } from "viem";
import { useAccount, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { arc, ARC_RPC_URLS } from "../lib/arc";
import { scanArcV6Abi, scanArcV6Bytecode, scanArcV6CompilerVersion } from "../lib/scanarc-v6.generated";
import { universalV2Abi as routerAbi, universalV2Bytecode as routerBytecode, universalV2CompilerVersion as universalCompilerVersion } from "../lib/scanarc-universal-v2.generated";

const OWNER = getAddress("0x25BE27a17580F59206061B8823E3c0FbC1F7c52E");
const ARCFUN_FACTORY = getAddress("0xBBf81Fd835B471C86d094eAaD35BB10068a987f8");
const LEGACY_V5 = getAddress("0x2E42f2daE317be31F8859ff000efaFD67dbb245F");
const EXISTING_ARC_WIDE_ROUTER = getAddress("0x303c8889930187a7b11280292055dd1364552d29");
const EXISTING_CCTP_BRIDGE = getAddress("0x777Fa929eA77a42aF8cb974d6C3e013D79cc1cfD");
const V6_STORAGE_KEY = "scanarc-router-v6:arc-mainnet";
const UNIVERSAL_STORAGE_KEY = "scanarc-universal-router-v2:arc-mainnet";
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const UNISWAP_UNIVERSAL_ROUTER = getAddress("0x8702463e73f74d0b6765aBceb314Ef07aCb92650");
const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");

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
  const [pairAttester, setPairAttester] = useState<`0x${string}` | null>(null);
  const [attesterError, setAttesterError] = useState<string | null>(null);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [routerAddress, setRouterAddress] = useState<`0x${string}` | null>(null);
  const [verifyState, setVerifyState] = useState<"idle" | "submitting" | "submitted" | "error">("idle");
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [universalRiskAccepted, setUniversalRiskAccepted] = useState(false);
  const [universalDeploying, setUniversalDeploying] = useState(false);
  const [universalTxHash, setUniversalTxHash] = useState<`0x${string}` | null>(null);
  const [universalAddress, setUniversalAddress] = useState<`0x${string}` | null>(null);
  const [universalVerifyState, setUniversalVerifyState] = useState<"idle" | "submitting" | "submitted" | "error">("idle");
  const [universalVerifyMessage, setUniversalVerifyMessage] = useState<string | null>(null);

  const correctOwner = !!address && address.toLowerCase() === OWNER.toLowerCase();
  const onArc = chainId === arc.id;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(V6_STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (isAddress(parsed?.address)) setRouterAddress(getAddress(parsed.address));
      if (/^0x[0-9a-fA-F]{64}$/.test(parsed?.hash ?? "")) setTxHash(parsed.hash);
    } catch { /* ignore malformed browser state */ }
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(UNIVERSAL_STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (isAddress(parsed?.address)) setUniversalAddress(getAddress(parsed.address));
      if (/^0x[0-9a-fA-F]{64}$/.test(parsed?.hash ?? "")) setUniversalTxHash(parsed.hash);
    } catch { /* ignore malformed browser state */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/scanarc/attester", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !isAddress(json?.address)) throw new Error(json?.error || "Pair attester is not configured.");
        if (!cancelled) { setPairAttester(getAddress(json.address)); setAttesterError(null); }
      } catch (cause) {
        if (!cancelled) setAttesterError(cause instanceof Error ? cause.message : "Pair attester lookup failed.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function connectOwnerWallet() {
    setError(null);
    if (!injected) { setError("No injected wallet was detected."); return; }
    setWalletOpening(true);
    resetConnect();
    try {
      await connectAsync({ connector: injected, chainId: arc.id });
      await sleep(500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection failed.");
    } finally {
      setWalletOpening(false);
    }
  }

  async function repairWalletArcNetwork() {
    setError(null);
    try {
      const ethereum = (window as any).ethereum;
      if (!ethereum?.request) throw new Error("Wallet provider unavailable.");
      try {
        await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${arc.id.toString(16)}` }] });
      } catch (switchError: any) {
        if (switchError?.code !== 4902) throw switchError;
        await ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: `0x${arc.id.toString(16)}`, chainName: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: [...ARC_RPC_URLS], blockExplorerUrls: [arc.blockExplorers.default.url] }],
        });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not repair Arc network."); }
  }

  function constructorArgs() {
    if (!pairAttester) throw new Error("Pair attester is not configured yet.");
    return [ARCFUN_FACTORY, OWNER, pairAttester] as const;
  }

  async function waitForCode(target: `0x${string}`) {
    if (!publicClient) return false;
    for (let i = 0; i < 20; i++) {
      const code = await publicClient.getBytecode({ address: target });
      if (code && code !== "0x") return true;
      await sleep(500);
    }
    return false;
  }

  async function validateV6(target: `0x${string}`) {
    if (!publicClient || !pairAttester) throw new Error("Validation client is not ready.");
    const read = (functionName: string, args?: readonly unknown[]) => publicClient.readContract({
      address: target,
      abi: scanArcV6Abi,
      functionName: functionName as any,
      args: args as any,
    });
    const [owner, attester, factory, version, direct] = await Promise.all([
      read("owner"), read("pairAttester"), read("arcfunFactory"), read("VERSION"), read("DIRECT_CURVE_EXECUTION"),
    ]);
    if (String(owner).toLowerCase() !== OWNER.toLowerCase()) throw new Error("V6 owner validation failed.");
    if (String(attester).toLowerCase() !== pairAttester.toLowerCase()) throw new Error("V6 pair attester validation failed.");
    if (String(factory).toLowerCase() !== ARCFUN_FACTORY.toLowerCase()) throw new Error("V6 Arcfun factory validation failed.");
    if (BigInt(String(version)) !== 6n) throw new Error("V6 version validation failed.");
    if (direct !== true) throw new Error("V6 direct-curve execution flag validation failed.");
  }

  async function deployV6() {
    setError(null);
    try {
      if (!address || !publicClient) throw new Error("Connect the owner wallet first.");
      if (!correctOwner) throw new Error(`Wrong wallet. Connect ${OWNER}.`);
      if (!pairAttester) throw new Error(attesterError || "Pair attester is not configured.");
      if (!riskAccepted) throw new Error("Confirm the V6 execution model first.");
      if (!onArc) { await switchChainAsync({ chainId: arc.id }); await sleep(700); }
      if (!walletClient) throw new Error("Wallet is not ready on Arc.");

      setDeploying(true); setTxHash(null); setRouterAddress(null); setVerifyState("idle");
      localStorage.removeItem(V6_STORAGE_KEY);

      const data = encodeDeployData({ abi: scanArcV6Abi, bytecode: scanArcV6Bytecode, args: constructorArgs() as any });
      const nonce = await publicClient.getTransactionCount({ address, blockTag: "pending" });
      const predictedAddress = getContractAddress({ from: address, nonce: BigInt(nonce) });
      const hash = await walletClient.sendTransaction({ account: address, chain: arc, data, gas: 1_500_000n });
      setTxHash(hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("ScanArc Router V6 deployment reverted.");
      const deployed = receipt.contractAddress ?? predictedAddress;
      if (!(await waitForCode(deployed))) throw new Error("V6 bytecode was not found after confirmation.");
      await validateV6(deployed);
      setRouterAddress(deployed);
      localStorage.setItem(V6_STORAGE_KEY, JSON.stringify({ address: deployed, hash }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "V6 deployment failed.");
    } finally { setDeploying(false); }
  }

  async function verifyV6() {
    setError(null); setVerifyState("submitting"); setVerifyMessage(null);
    try {
      if (!routerAddress) throw new Error("Deploy V6 first.");
      const encoded = encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }],
        constructorArgs() as any,
      );
      const res = await fetch("/api/blockscout/verify-v6", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: routerAddress, constructorArguments: encoded.slice(2) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "V6 verification failed.");
      setVerifyState("submitted"); setVerifyMessage(json?.message || "V6 verification submitted.");
    } catch (cause) {
      setVerifyState("error"); setError(cause instanceof Error ? cause.message : "V6 verification failed.");
    }
  }

  function universalConstructorArgs() {
    return [ARC_USDC, UNISWAP_UNIVERSAL_ROUTER, PERMIT2, OWNER, OWNER] as const;
  }

  async function validateUniversal(target: `0x${string}`) {
    if (!publicClient) throw new Error("Validation client is not ready.");
    const read = (functionName: string) => publicClient.readContract({
      address: target, abi: routerAbi, functionName: functionName as any,
    });
    const [owner, usdc, universalRouter, permit2, feeRecipient, feeBps] = await Promise.all([
      read("owner"), read("usdc"), read("universalRouter"), read("permit2"), read("feeRecipient"), read("FEE_BPS"),
    ]);
    if (String(owner).toLowerCase() !== OWNER.toLowerCase()) throw new Error("Universal Router owner validation failed.");
    if (String(usdc).toLowerCase() !== ARC_USDC.toLowerCase()) throw new Error("Arc USDC validation failed.");
    if (String(universalRouter).toLowerCase() !== UNISWAP_UNIVERSAL_ROUTER.toLowerCase()) throw new Error("Uniswap Universal Router validation failed.");
    if (String(permit2).toLowerCase() !== PERMIT2.toLowerCase()) throw new Error("Permit2 validation failed.");
    if (String(feeRecipient).toLowerCase() !== OWNER.toLowerCase()) throw new Error("Fee recipient validation failed.");
    if (BigInt(String(feeBps)) !== 25n) throw new Error("ScanArc fee validation failed.");
  }

  async function deployUniversal() {
    setError(null);
    try {
      if (!address || !publicClient) throw new Error("Connect the owner wallet first.");
      if (!correctOwner) throw new Error(`Wrong wallet. Connect ${OWNER}.`);
      if (!universalRiskAccepted) throw new Error("Confirm the Universal Buy execution model first.");
      if (!onArc) { await switchChainAsync({ chainId: arc.id }); await sleep(700); }
      if (!walletClient) throw new Error("Wallet is not ready on Arc.");

      setUniversalDeploying(true); setUniversalTxHash(null); setUniversalAddress(null); setUniversalVerifyState("idle");
      localStorage.removeItem(UNIVERSAL_STORAGE_KEY);
      const data = encodeDeployData({ abi: routerAbi, bytecode: routerBytecode, args: universalConstructorArgs() as any });
      const nonce = await publicClient.getTransactionCount({ address, blockTag: "pending" });
      const predictedAddress = getContractAddress({ from: address, nonce: BigInt(nonce) });
      const hash = await walletClient.sendTransaction({ account: address, chain: arc, data, gas: 2_500_000n });
      setUniversalTxHash(hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("ScanArc Universal Router V2 deployment reverted.");
      const deployed = receipt.contractAddress ?? predictedAddress;
      if (!(await waitForCode(deployed))) throw new Error("Universal Router bytecode was not found after confirmation.");
      await validateUniversal(deployed);
      setUniversalAddress(deployed);
      localStorage.setItem(UNIVERSAL_STORAGE_KEY, JSON.stringify({ address: deployed, hash }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Universal Router deployment failed.");
    } finally { setUniversalDeploying(false); }
  }

  async function verifyUniversal() {
    setError(null); setUniversalVerifyState("submitting"); setUniversalVerifyMessage(null);
    try {
      if (!universalAddress) throw new Error("Deploy Universal Router V2 first.");
      const encoded = encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }],
        universalConstructorArgs() as any,
      );
      const res = await fetch("/api/blockscout/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: universalAddress, constructorArguments: encoded.slice(2) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Universal Router verification failed.");
      setUniversalVerifyState("submitted");
      setUniversalVerifyMessage(json?.message || "Universal Router verification submitted.");
    } catch (cause) {
      setUniversalVerifyState("error"); setError(cause instanceof Error ? cause.message : "Universal Router verification failed.");
    }
  }

  function clearSavedUniversal() {
    localStorage.removeItem(UNIVERSAL_STORAGE_KEY);
    setUniversalTxHash(null); setUniversalAddress(null); setUniversalVerifyState("idle"); setUniversalVerifyMessage(null); setError(null);
  }

  function clearSavedV6() {
    localStorage.removeItem(V6_STORAGE_KEY);
    setTxHash(null); setRouterAddress(null); setVerifyState("idle"); setVerifyMessage(null); setError(null);
  }

  return <main className="shell">
    <header className="hero">
      <div className="brandRow"><div className="mark">A</div><div><div className="eyebrow">SCANARC · ARC MAINNET</div><div className="networkPill"><i /> Arc 5042</div></div></div>
      <h1>ScanArc Deployment Center</h1>
      <p>Deploy Router V6 for canonical Arcfun curves and Universal Router V2 for one-tap Arc market buys with ScanArc's 0.25% execution fee.</p>
    </header>

    <section className="statusGrid">
      <article><span>NEW DEPLOYMENTS</span><b>2</b><small>Router V6 + Universal Buy</small></article>
      <article><span>CURVE EXECUTION</span><b>DIRECT</b><small>User → canonical curve</small></article>
      <article><span>CUSTODY</span><b>NONE</b><small>V6 never holds trade assets</small></article>
      <article><span>OLDER CONTRACTS</span><b>KEEP</b><small>No redeploys</small></article>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">01</span><div><h2>Connect owner</h2><p>Deploy V6 from the existing ScanArc owner wallet.</p></div></div>
      {!isConnected ? <button className="primary" disabled={!injected || walletOpening} onClick={connectOwnerWallet}>{walletOpening ? "Opening wallet…" : "Connect wallet"}</button> : <div className="walletBox"><div><span>CONNECTED WALLET</span><b className={correctOwner ? "good" : "bad"}>{address}</b></div><button className="ghost compact" onClick={() => disconnect()}>Disconnect</button></div>}
      {isConnected && !correctOwner && <div className="notice danger">Wrong wallet. Connect <code>{OWNER}</code>.</div>}
      {isConnected && correctOwner && !onArc && <button className="primary" disabled={isSwitching} onClick={() => switchChainAsync({ chainId: arc.id })}>{isSwitching ? "Switching…" : "Switch to Arc Mainnet"}</button>}
      {isConnected && correctOwner && onArc && <div className="notice success">✓ Approved owner connected on Arc.</div>}
      <button className="secondary" disabled={!isConnected} onClick={repairWalletArcNetwork}>Repair Arc network in wallet</button>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">02</span><div><h2>Preserve existing deployments</h2><p>V6 is additive on-chain. Nothing already deployed is redeployed or initialized again.</p></div></div>
      <div className="details">
        <div><span>Legacy Arcfun V5</span><code>{LEGACY_V5}</code></div>
        <div><span>Arc-Wide Router V1</span><code>{EXISTING_ARC_WIDE_ROUTER}</code></div>
        <div><span>CCTP Bridge V1</span><code>{EXISTING_CCTP_BRIDGE}</code></div>
        <div><span>Action</span><strong>Leave all three unchanged</strong></div>
      </div>
      <div className="notice">V5 stays deployed but should no longer execute pre-graduation curve trades after the app is switched to V6.</div>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">03</span><div><h2>Validate V6 model</h2><p>Arcfun's pre-graduation launch guard makes intermediary token custody incompatible with a normal router. V6 therefore verifies the canonical pair without touching trade funds.</p></div></div>
      <div className="details">
        <div><span>Canonical Arcfun factory</span><code>{ARCFUN_FACTORY}</code></div>
        <div><span>Pair attester</span>{pairAttester ? <code>{pairAttester}</code> : <strong className="bad">Not configured</strong>}</div>
        <div><span>Pre-graduation path</span><strong>Wallet → curve directly</strong></div>
        <div><span>Graduated path</span><strong>Existing Arc-Wide Router V1</strong></div>
        <div><span>V6 asset custody</span><strong>None</strong></div>
        <div><span>Follow-up config tx</span><strong>None</strong></div>
      </div>
      {attesterError && <div className="notice danger">{attesterError}</div>}
      <label className="check"><input type="checkbox" checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)} /><span>I understand V6 is the authorization gate for direct canonical curve calls. It does not pull USDC/tokens into itself and does not attempt the incompatible V5 intermediary trade path.</span></label>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">04</span><div><h2>Deploy Router V6</h2><p>Exactly one new contract deployment. All required V6 configuration is supplied in the constructor.</p></div></div>
      {!routerAddress ? <button className="primary deploy" disabled={!isConnected || !correctOwner || !onArc || !pairAttester || !riskAccepted || deploying} onClick={deployV6}>{deploying ? "Deploying Router V6…" : "Deploy ScanArc Router V6"}</button> : <div className="notice success strong">✓ Router V6 deployed and its owner, attester, factory, version and direct-execution mode were validated on-chain.</div>}
      {txHash && <a className="linkButton" href={explorerTx(txHash)} target="_blank" rel="noreferrer">View V6 deployment ↗</a>}
    </section>

    {routerAddress && <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">05</span><div><h2>Verify Router V6</h2><p>Publish the exact V6 Solidity source and exact constructor arguments to Blockscout.</p></div></div>
      <div className="contractBox"><span>DEPLOYED ROUTER V6</span><strong>{routerAddress}</strong></div>
      <div className="verifyMeta"><span>{scanArcV6CompilerVersion}</span><span>Optimizer 200</span><span>viaIR</span><span>EIP-712 v6</span></div>
      <button className="secondary" disabled={verifyState === "submitting"} onClick={verifyV6}>{verifyState === "submitting" ? "Submitting verification…" : "Verify Router V6"}</button>
      {verifyState === "submitted" && <div className="notice success">✓ {verifyMessage}</div>}
      <a className="linkButton" href={explorerAddress(routerAddress)} target="_blank" rel="noreferrer">Open V6 on Arc Explorer ↗</a>
    </section>}

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">06</span><div><h2>Universal Buy Router</h2><p>Deploy the Arc-wide execution adapter that lets ScanArc turn a token selection into a simple Buy action for supported Uniswap v4 markets.</p></div></div>
      <div className="details">
        <div><span>Arc USDC</span><code>{ARC_USDC}</code></div>
        <div><span>Uniswap Universal Router 2.1.2</span><code>{UNISWAP_UNIVERSAL_ROUTER}</code></div>
        <div><span>Permit2</span><code>{PERMIT2}</code></div>
        <div><span>ScanArc fee</span><strong>0.25% · 25 bps</strong></div>
        <div><span>Fee recipient</span><code>{OWNER}</code></div>
        <div><span>Route scope</span><strong>USDC ↔ supported Arc v4 markets</strong></div>
      </div>
      <div className="notice">This is additive. It does not replace Router V6. V2 starts on Uniswap Universal Router 2.1.2 and lets the ScanArc owner update the underlying Uniswap router later without redeploying this contract.</div>
      <label className="check"><input type="checkbox" checked={universalRiskAccepted} onChange={(e) => setUniversalRiskAccepted(e.target.checked)} /><span>I confirm Arc USDC, Permit2, owner and fee-recipient values. The contract starts on Uniswap Universal Router 2.1.2; the owner can later update only the approved Universal Router address without redeploying ScanArc. The fee remains 0.25%.</span></label>
      {!universalAddress ? <button className="primary deploy" disabled={!isConnected || !correctOwner || !onArc || !universalRiskAccepted || universalDeploying} onClick={deployUniversal}>{universalDeploying ? "Deploying Universal Buy Router…" : "Deploy Universal Buy Router"}</button> : <div className="notice success strong">✓ Universal Buy Router V2 deployed and its owner, Arc USDC, current Uniswap Router, Permit2, fee recipient and 25 bps fee were validated on-chain.</div>}
      {universalTxHash && <a className="linkButton" href={explorerTx(universalTxHash)} target="_blank" rel="noreferrer">View Universal deployment ↗</a>}
    </section>

    {universalAddress && <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">07</span><div><h2>Verify Universal Buy Router</h2><p>Publish the exact Universal Router V2 source and constructor arguments to Blockscout.</p></div></div>
      <div className="contractBox"><span>DEPLOYED UNIVERSAL ROUTER V2</span><strong>{universalAddress}</strong></div>
      <div className="verifyMeta"><span>{universalCompilerVersion}</span><span>Optimizer 200</span><span>viaIR</span><span>Fee 25 bps</span></div>
      <button className="secondary" disabled={universalVerifyState === "submitting"} onClick={verifyUniversal}>{universalVerifyState === "submitting" ? "Submitting verification…" : "Verify Universal Router V2"}</button>
      {universalVerifyState === "submitted" && <div className="notice success">✓ {universalVerifyMessage}</div>}
      <a className="linkButton" href={explorerAddress(universalAddress)} target="_blank" rel="noreferrer">Open Universal Router on Arc Explorer ↗</a>
      <button className="ghost reset" onClick={clearSavedUniversal}>Clear saved Universal deployment from this browser</button>
    </section>}

    {(error || connectError) && <section className="card error"><b>Stopped safely</b><p>{error ?? connectError?.message}</p></section>}
    {routerAddress && <button className="ghost reset" onClick={clearSavedV6}>Clear saved V6 deployment from this browser</button>}

    <footer>After deployment, wire ScanArc token Buy actions to the route engine: canonical pre-graduation Arcfun trades remain direct through V6 authorization, while supported Arc v4 USDC markets can execute through Universal Router V2. Crosschain CCTP/Gateway routing remains a separate adapter step and is not silently enabled by this deployment.</footer>
  </main>;
}
