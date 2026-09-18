"use client";

import { useEffect, useMemo, useState } from "react";
import { encodeAbiParameters, encodeDeployData, getAddress, getContractAddress, isAddress } from "viem";
import { useAccount, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { arc, ARC_RPC_URLS } from "../lib/arc";
import { scanArcV6Abi, scanArcV6Bytecode, scanArcV6CompilerVersion } from "../lib/scanarc-v6.generated";

const OWNER = getAddress("0x25BE27a17580F59206061B8823E3c0FbC1F7c52E");
const ARCFUN_FACTORY = getAddress("0xBBf81Fd835B471C86d094eAaD35BB10068a987f8");
const LEGACY_V5 = getAddress("0x2E42f2daE317be31F8859ff000efaFD67dbb245F");
const EXISTING_ARC_WIDE_ROUTER = getAddress("0x303c8889930187a7b11280292055dd1364552d29");
const EXISTING_CCTP_BRIDGE = getAddress("0x777Fa929eA77a42aF8cb974d6C3e013D79cc1cfD");
const V6_STORAGE_KEY = "scanarc-router-v6:arc-mainnet";

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

  function clearSavedV6() {
    localStorage.removeItem(V6_STORAGE_KEY);
    setTxHash(null); setRouterAddress(null); setVerifyState("idle"); setVerifyMessage(null); setError(null);
  }

  return <main className="shell">
    <header className="hero">
      <div className="brandRow"><div className="mark">A</div><div><div className="eyebrow">SCANARC · ARC MAINNET</div><div className="networkPill"><i /> Arc 5042</div></div></div>
      <h1>ScanArc Router V6</h1>
      <p>Replace V5's incompatible curve intermediary with a no-custody authorization gate built for direct canonical Arcfun curve execution.</p>
    </header>

    <section className="statusGrid">
      <article><span>NEW DEPLOYMENTS</span><b>1</b><small>Router V6 only</small></article>
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

    {(error || connectError) && <section className="card error"><b>Stopped safely</b><p>{error ?? connectError?.message}</p></section>}
    {routerAddress && <button className="ghost reset" onClick={clearSavedV6}>Clear saved V6 deployment from this browser</button>}

    <footer>After V6 is deployed, update ScanArc's attestation request to use the V6 address and EIP-712 version 6. Canonical pre-graduation buys/sells must still be sent directly from the user's wallet to the canonical Arcfun curve; graduated tokens continue through the existing Arc-Wide Router V1.</footer>
  </main>;
}
