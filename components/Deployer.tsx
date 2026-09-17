"use client";

import { useEffect, useMemo, useState } from "react";
import { encodeAbiParameters, encodeDeployData, getAddress, getContractAddress, isAddress } from "viem";
import { useAccount, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { arc, ARC_RPC_URLS } from "../lib/arc";
import { routerAbi, routerBytecode, compilerVersion } from "../lib/scanarc-router.generated";

const OWNER = getAddress("0x25BE27a17580F59206061B8823E3c0FbC1F7c52E");
const FEE_RECIPIENT = OWNER;
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const ARCFUN_FACTORY = getAddress("0xBBf81Fd835B471C86d094eAaD35BB10068a987f8");
const ARCFUN_V4_ROUTER = getAddress("0xBb325390FFee8f963e2FaF58F8409f62658b225a");
const ARCFUN_V4_QUOTER = getAddress("0x518d3775d5eaCf367AaD623EE93D4869D5D42234");
const KNOWN_TOKEN = "0x305bf34dea03a0fb2bd7a24295f00d8163601aae";
const KNOWN_CURVE = "0x4beec7f96c0582e1e573d16aa113d6fe01864029";
const V1_ROUTER = "0xd973c23dC4eDA22c4b4754a543f29d206B387072";
const V3_ROUTER = "0x5086367d0D309a35264a7884E3eC49Cd87F0610A";
const STORAGE_KEY = "scanarc-router:arc-mainnet:v5";

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function explorerAddress(address: string) { return `${arc.blockExplorers.default.url}/address/${address}`; }
function explorerTx(hash: string) { return `${arc.blockExplorers.default.url}/tx/${hash}`; }

type Provenance = {
  proof: string;
  creationTransaction: `0x${string}`;
  tokenCreator?: string | null;
  curveCreator?: string | null;
  launchTarget?: string | null;
};

type Attestation = {
  validUntil: string;
  signature: `0x${string}`;
  attester: `0x${string}`;
  proof: string;
};

export function Deployer() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending: isConnecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { data: walletClient } = useWalletClient({ chainId: arc.id });
  const publicClient = usePublicClient({ chainId: arc.id });
  const injected = useMemo(() => connectors.find((connector) => connector.id === "injected"), [connectors]);

  const [riskAccepted, setRiskAccepted] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [contractAddress, setContractAddress] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testToken, setTestToken] = useState<string>(KNOWN_TOKEN);
  const [testCurve, setTestCurve] = useState<string>(KNOWN_CURVE);
  const [attesterAddress, setAttesterAddress] = useState<`0x${string}` | null>(null);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [checkingProvenance, setCheckingProvenance] = useState(false);
  const [testingPair, setTestingPair] = useState(false);
  const [pairResult, setPairResult] = useState<boolean | null>(null);
  const [infraOk, setInfraOk] = useState<boolean | null>(null);
  const [verifyState, setVerifyState] = useState<"idle" | "submitting" | "submitted" | "error">("idle");
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);

  const onArc = chainId === arc.id;
  const correctOwner = address?.toLowerCase() === OWNER.toLowerCase();

  useEffect(() => {
    fetch("/api/scanarc/attester", { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || "Attester is not configured.");
        if (!isAddress(json.address)) throw new Error("Attester endpoint returned an invalid address.");
        setAttesterAddress(getAddress(json.address));
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Attester configuration failed."));

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as { address?: `0x${string}`; hash?: `0x${string}` };
      if (parsed.address && isAddress(parsed.address)) setContractAddress(getAddress(parsed.address));
      if (parsed.hash) setHash(parsed.hash);
    } catch {}
  }, []);

  async function waitForCode(target: `0x${string}`) {
    if (!publicClient) return false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = await publicClient.getBytecode({ address: target });
      if (code && code !== "0x") return true;
      await sleep(2000);
    }
    return false;
  }

  async function checkInfrastructure() {
    if (!publicClient) throw new Error("Arc RPC is unavailable.");
    const addresses = [ARC_USDC, ARCFUN_FACTORY, ARCFUN_V4_ROUTER, ARCFUN_V4_QUOTER] as const;
    const codes = await Promise.all(addresses.map((target) => publicClient.getBytecode({ address: target })));
    const ok = codes.every((code) => Boolean(code && code !== "0x"));
    setInfraOk(ok);
    if (!ok) throw new Error("One or more canonical Arc/Arcfun contracts have no bytecode.");
  }

  async function checkProvenance() {
    setError(null); setProvenance(null); setPairResult(null); setCheckingProvenance(true);
    try {
      if (!isAddress(testToken) || !isAddress(testCurve)) throw new Error("Enter a valid known Arcfun token and curve address.");
      const res = await fetch("/api/scanarc/provenance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: getAddress(testToken), curve: getAddress(testCurve) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Could not prove Arcfun launch provenance.");
      setProvenance(json as Provenance);
      if (!attesterAddress) {
        const signerRes = await fetch("/api/scanarc/attester", { cache: "no-store" });
        const signerJson = await signerRes.json();
        if (!signerRes.ok || !isAddress(signerJson?.address)) throw new Error(signerJson?.error || "Attester is not configured.");
        setAttesterAddress(getAddress(signerJson.address));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Provenance check failed."); }
    finally { setCheckingProvenance(false); }
  }

  async function validateRouter(target: `0x${string}`, expectedAttester: `0x${string}`) {
    if (!publicClient) throw new Error("Arc RPC is unavailable.");
    const read = (functionName: string) => publicClient.readContract({ address: target, abi: routerAbi, functionName } as any);
    const [owner, recipient, fee, usdc, factory, v4Router, attester, pendingOwner] = await Promise.all([
      read("owner"), read("feeRecipient"), read("FEE_BPS"), read("usdc"), read("arcfunFactory"), read("arcfunV4Router"), read("pairAttester"), read("pendingOwner"),
    ]);
    if (String(owner).toLowerCase() !== OWNER.toLowerCase()) throw new Error("Router owner validation failed.");
    if (String(recipient).toLowerCase() !== FEE_RECIPIENT.toLowerCase()) throw new Error("Fee recipient validation failed.");
    if (BigInt(String(fee)) !== 25n) throw new Error("Fee validation failed. Expected 25 bps.");
    if (String(usdc).toLowerCase() !== ARC_USDC.toLowerCase()) throw new Error("Arc USDC validation failed.");
    if (String(factory).toLowerCase() !== ARCFUN_FACTORY.toLowerCase()) throw new Error("Arcfun factory validation failed.");
    if (String(v4Router).toLowerCase() !== ARCFUN_V4_ROUTER.toLowerCase()) throw new Error("Arcfun V4 router validation failed.");
    if (String(attester).toLowerCase() !== expectedAttester.toLowerCase()) throw new Error("Pair attester validation failed.");
    if (String(pendingOwner).toLowerCase() !== "0x0000000000000000000000000000000000000000") throw new Error("Unexpected pending owner detected.");
  }

  async function repairWalletArcNetwork() {
    setError(null);
    try {
      if (!walletClient) throw new Error("Connect your wallet first.");
      await walletClient.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x13b2", chainName: "Arc", nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 }, rpcUrls: [...ARC_RPC_URLS], blockExplorerUrls: [arc.blockExplorers.default.url] }] } as any);
      await switchChainAsync({ chainId: arc.id });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Wallet network repair was not accepted."); }
  }

  function constructorArgs(signer: `0x${string}`) {
    return [ARC_USDC, ARCFUN_FACTORY, ARCFUN_V4_ROUTER, FEE_RECIPIENT, OWNER, signer] as const;
  }

  async function deploy() {
    setError(null);
    try {
      if (!address || !publicClient || !attesterAddress || !provenance) throw new Error("Prove the known pair and configure the attester first.");
      if (!correctOwner) throw new Error(`Wrong wallet. Connect ${OWNER}.`);
      if (!riskAccepted) throw new Error("Confirm the deployment safety gate first.");
      if (!onArc) { await switchChainAsync({ chainId: arc.id }); await sleep(700); }
      if (!walletClient) throw new Error("Wallet is not ready on Arc.");
      await checkInfrastructure();
      setDeploying(true); setHash(null); setContractAddress(null); setPairResult(null); localStorage.removeItem(STORAGE_KEY);

      const data = encodeDeployData({ abi: routerAbi, bytecode: routerBytecode, args: constructorArgs(attesterAddress) as any });
      const nonce = await publicClient.getTransactionCount({ address, blockTag: "pending" });
      const predictedAddress = getContractAddress({ from: address, nonce: BigInt(nonce) });
      const gas = 3_200_000n;
      let txHash: `0x${string}`;
      try { txHash = await walletClient.sendTransaction({ account: address, chain: arc, data, gas }); }
      catch (walletError) {
        if (await waitForCode(predictedAddress)) {
          await validateRouter(predictedAddress, attesterAddress);
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
      if (!(await waitForCode(deployed))) throw new Error("Transaction confirmed, but no V5 router bytecode was found.");
      await validateRouter(deployed, attesterAddress);
      setContractAddress(deployed);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ address: deployed, hash: txHash }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Deployment failed."); }
    finally { setDeploying(false); }
  }

  async function verifySource() {
    setError(null); setVerifyState("submitting"); setVerifyMessage(null);
    try {
      if (!contractAddress || !attesterAddress) throw new Error("Deploy V5 first.");
      const encoded = encodeAbiParameters(
        [{type:"address"},{type:"address"},{type:"address"},{type:"address"},{type:"address"},{type:"address"}],
        constructorArgs(attesterAddress) as any,
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

  async function testAuthorizedPair() {
    setError(null); setPairResult(null); setTestingPair(true);
    try {
      if (!contractAddress || !publicClient || !attesterAddress) throw new Error("Deploy V5 first.");
      if (!isAddress(testToken) || !isAddress(testCurve)) throw new Error("Enter valid token and curve addresses.");
      const res = await fetch("/api/scanarc/attest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: getAddress(testToken), curve: getAddress(testCurve), router: contractAddress }),
      });
      const auth = await res.json() as Attestation & { error?: string };
      if (!res.ok) throw new Error(auth?.error || "Pair attestation failed.");
      if (auth.attester.toLowerCase() !== attesterAddress.toLowerCase()) throw new Error("Backend signer does not match the router attester.");
      const result = await publicClient.readContract({
        address: contractAddress,
        abi: routerAbi,
        functionName: "isAuthorizedPair",
        args: [getAddress(testToken), getAddress(testCurve), BigInt(auth.validUntil), auth.signature],
      } as any);
      setPairResult(Boolean(result));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Pair authorization test failed."); }
    finally { setTestingPair(false); }
  }

  function clearSavedRouter() {
    localStorage.removeItem(STORAGE_KEY);
    setHash(null); setContractAddress(null); setPairResult(null); setInfraOk(null); setVerifyState("idle"); setError(null);
  }

  const deployReady = Boolean(isConnected && correctOwner && onArc && riskAccepted && attesterAddress && provenance && !deploying);

  return <main className="shell">
    <header className="hero"><div className="brandRow"><div className="mark">A</div><div><div className="eyebrow">SCANARC · ARC MAINNET</div><div className="networkPill"><i /> Arc 5042</div></div></div><h1>ScanArc Router V5</h1><p>Factory provenance + short-lived signed pair authorization. No per-token owner onboarding and no guessed factory getter.</p></header>
    <section className="statusGrid"><article><span>SCANARC FEE</span><b>0.25%</b><small>25 bps · immutable</small></article><article><span>PAIR AUTH</span><b>EIP-712</b><small>Provenance-signed</small></article><article><span>PRE-GRAD</span><b>CURVE</b><small>Official bonding curve</small></article><article><span>POST-GRAD</span><b>V4</b><small>Canonical Arcfun router</small></article></section>

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">01</span><div><h2>Connect owner</h2><p>Use the approved deployment wallet on Arc.</p></div></div>
      {!isConnected ? <button className="primary" disabled={!injected || isConnecting} onClick={() => injected && connect({ connector: injected })}>{isConnecting ? "Opening wallet…" : "Connect wallet"}</button> : <div className="walletBox"><div><span>CONNECTED WALLET</span><b className={correctOwner ? "good" : "bad"}>{address}</b></div><button className="ghost compact" onClick={() => disconnect()}>Disconnect</button></div>}
      {isConnected && !correctOwner && <div className="notice danger">Wrong wallet. Connect <code>{OWNER}</code>.</div>}
      {isConnected && correctOwner && !onArc && <button className="primary" disabled={isSwitching} onClick={() => switchChainAsync({ chainId: arc.id })}>{isSwitching ? "Switching…" : "Switch to Arc Mainnet"}</button>}
      {isConnected && correctOwner && onArc && <div className="notice success">✓ Approved owner connected on Arc.</div>}
      <button className="secondary" disabled={!isConnected} onClick={repairWalletArcNetwork}>Repair Arc network in wallet</button>
    </section>

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">02</span><div><h2>Prove an Arcfun launch</h2><p>Blockscout must prove the token and curve came from the same canonical Arcfun factory launch transaction. This replaces the failed V4 getter guessing.</p></div></div>
      <label className="field">Known official token<input value={testToken} onChange={(e) => { setTestToken(e.target.value); setProvenance(null); }} autoCapitalize="none" autoCorrect="off" /></label>
      <label className="field">Known official curve<input value={testCurve} onChange={(e) => { setTestCurve(e.target.value); setProvenance(null); }} autoCapitalize="none" autoCorrect="off" /></label>
      <button className="secondary" disabled={checkingProvenance} onClick={checkProvenance}>{checkingProvenance ? "Checking creation provenance…" : "Prove known Arcfun pair"}</button>
      {provenance && <div className="notice success strong">✓ {provenance.proof}<br/>Launch tx: <code>{provenance.creationTransaction}</code></div>}
    </section>

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">03</span><div><h2>Review signer & infrastructure</h2><p>The signer has one narrow job: authorize pairs after the server proves canonical launch provenance. It cannot move funds.</p></div></div>
      <div className="details"><div><span>Pair attester</span><code>{attesterAddress ?? "SCANARC_ATTESTER_PRIVATE_KEY not configured"}</code></div><div><span>Arc USDC</span><code>{ARC_USDC}</code></div><div><span>Arcfun Factory</span><code>{ARCFUN_FACTORY}</code></div><div><span>Arcfun V4 Router</span><code>{ARCFUN_V4_ROUTER}</code></div><div><span>Fee recipient</span><code>{FEE_RECIPIENT}</code></div><div><span>Owner</span><code>{OWNER}</code></div></div>
      <button className="secondary" disabled={!onArc || !publicClient} onClick={() => checkInfrastructure().catch((e) => setError(e instanceof Error ? e.message : "Infrastructure check failed."))}>Check canonical contracts</button>
      {infraOk && <div className="notice success">✓ Canonical contracts have bytecode on Arc.</div>}
    </section>

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">04</span><div><h2>Deploy Router V5</h2><p>V1 and V3 stay deployed but are not used. Do not deploy the blocked V4 design.</p></div></div>
      <div className="notice"><b>Old V1:</b> <code>{V1_ROUTER}</code><br/><b>Old V3:</b> <code>{V3_ROUTER}</code><br/>V5 is independent of both.</div>
      <label className="check"><input type="checkbox" checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)} /><span>I reviewed the fixed infrastructure, provenance proof and dedicated attester. This is production-oriented beta code, not an independent audit.</span></label>
      {!contractAddress ? <button className="primary deploy" disabled={!deployReady} onClick={deploy}>{deploying ? "Deploying ScanArc Router V5…" : "Deploy ScanArc Router V5"}</button> : <div className="notice success strong">✓ V5 deployed and settings validated.</div>}
      {hash && <a className="linkButton" href={explorerTx(hash)} target="_blank" rel="noreferrer">View deployment transaction ↗</a>}
    </section>

    {contractAddress && <section className="card stepCard"><div className="stepHead"><span className="stepNo">05</span><div><h2>Verify on Blockscout</h2><p>Uses BLOCKSCOUT_API_KEY server-side with the exact viaIR standard JSON build.</p></div></div><div className="contractBox"><span>DEPLOYED V5 ROUTER</span><strong>{contractAddress}</strong></div><div className="verifyMeta"><span>{compilerVersion}</span><span>viaIR ON</span><span>Optimizer 200</span></div><button className="secondary" disabled={verifyState === "submitting"} onClick={verifySource}>{verifyState === "submitting" ? "Submitting verification…" : "Verify V5 with Blockscout"}</button>{verifyState === "submitted" && <div className="notice success">✓ {verifyMessage}</div>}<a className="linkButton" href={explorerAddress(contractAddress)} target="_blank" rel="noreferrer">Open V5 on Arc Explorer ↗</a></section>}

    {contractAddress && <section className="card stepCard"><div className="stepHead"><span className="stepNo">06</span><div><h2>Test automatic pair authorization</h2><p>The backend re-checks factory provenance, signs a 24-hour EIP-712 authorization, and V5 verifies it on-chain.</p></div></div><button className="secondary" disabled={testingPair} onClick={testAuthorizedPair}>{testingPair ? "Proving & signing pair…" : "Test known pair authorization"}</button>{pairResult === true && <div className="notice success strong">✓ Pair authorization verified on-chain. No owner setPair transaction is required.</div>}{pairResult === false && <div className="notice danger"><b>Authorization failed.</b> Do not connect public trading.</div>}</section>}

    <section className="card stepCard"><div className="stepHead"><span className="stepNo">07</span><div><h2>How production trading works</h2><p>Your ScanArc API requests an authorization automatically when a user opens/trades an Arcfun token.</p></div></div><div className="details"><div><span>New official token</span><strong>Blockscout provenance → signed auth</strong></div><div><span>Unbonded token</span><strong>buyCurve / sellCurve</strong></div><div><span>Graduated token</span><strong>buyGraduated / sellGraduated</strong></div><div><span>Random token/curve</span><strong>Rejected</strong></div><div><span>Emergency response</span><strong>Block pair / rotate attester</strong></div></div></section>

    {(error || connectError) && <section className="card error"><b>Stopped safely</b><p>{error ?? connectError?.message}</p></section>}
    {contractAddress && <button className="ghost reset" onClick={clearSavedRouter}>Clear saved V5 deployment from this browser</button>}
    <footer>Do not route public funds until the known-pair authorization test passes and small curve + graduated V4 trades are tested end to end.</footer>
  </main>;
}
