"use client";

import { useEffect, useMemo, useState } from "react";
import { encodeDeployData, getAddress, getContractAddress, isAddress } from "viem";
import { useAccount, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { arc } from "../lib/arc";
import { routerAbi, routerBytecode, compilerVersion } from "../lib/scanarc-router.generated";

const OWNER = getAddress("0x25BE27a17580F59206061B8823E3c0FbC1F7c52E");
const FEE_RECIPIENT = OWNER;
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const ARCFUN_FACTORY = getAddress("0xBBf81Fd835B471C86d094eAaD35BB10068a987f8");
const ARCFUN_V4_ROUTER = getAddress("0xBb325390FFee8f963e2FaF58F8409f62658b225a");
const ARCFUN_V4_QUOTER = getAddress("0x518d3775d5eaCf367AaD623EE93D4869D5D42234");
const KNOWN_TOKEN = getAddress("0x305bf34dea03a0fb2bd7a24295f00d8163601aae");
const KNOWN_CURVE = getAddress("0x4beec7f96c0582e1e573d16aa113d6fe01864029");
const V1_ROUTER = getAddress("0xd973c23dC4eDA22c4b4754a543f29d206B387072");
const STORAGE_KEY = "scanarc-router:arc-mainnet:v3";

function short(value?: string) { return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—"; }
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function explorerAddress(address: string) { return `${arc.blockExplorers.default.url}/address/${address}`; }
function explorerTx(hash: string) { return `${arc.blockExplorers.default.url}/tx/${hash}`; }

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
  const [sourceVerified, setSourceVerified] = useState(false);
  const [testToken, setTestToken] = useState<string>(KNOWN_TOKEN);
  const [testCurve, setTestCurve] = useState<string>(KNOWN_CURVE);
  const [testingPair, setTestingPair] = useState(false);
  const [pairResult, setPairResult] = useState<boolean | null>(null);
  const [infraOk, setInfraOk] = useState<boolean | null>(null);

  const onArc = chainId === arc.id;
  const correctOwner = address?.toLowerCase() === OWNER.toLowerCase();

  useEffect(() => {
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
    if (!ok) throw new Error("One or more canonical Arc/Arcfun contracts have no bytecode. Stop and re-check addresses.");
    return true;
  }

  async function validateRouter(target: `0x${string}`) {
    if (!publicClient) throw new Error("Arc RPC is unavailable.");
    const read = (functionName: string) => publicClient.readContract({ address: target, abi: routerAbi, functionName } as any);
    const [owner, recipient, fee, usdc, factory, v4Router, pendingOwner] = await Promise.all([
      read("owner"), read("feeRecipient"), read("FEE_BPS"), read("usdc"), read("arcfunFactory"), read("arcfunV4Router"), read("pendingOwner"),
    ]);
    if (String(owner).toLowerCase() !== OWNER.toLowerCase()) throw new Error("Router owner validation failed.");
    if (String(recipient).toLowerCase() !== FEE_RECIPIENT.toLowerCase()) throw new Error("Fee recipient validation failed.");
    if (BigInt(String(fee)) !== 25n) throw new Error("Fee validation failed. Expected 25 bps.");
    if (String(usdc).toLowerCase() !== ARC_USDC.toLowerCase()) throw new Error("Arc USDC validation failed.");
    if (String(factory).toLowerCase() !== ARCFUN_FACTORY.toLowerCase()) throw new Error("Arcfun factory validation failed.");
    if (String(v4Router).toLowerCase() !== ARCFUN_V4_ROUTER.toLowerCase()) throw new Error("Arcfun V4 router validation failed.");
    if (String(pendingOwner).toLowerCase() !== "0x0000000000000000000000000000000000000000") throw new Error("Unexpected pending owner detected.");
  }

  async function deploy() {
    setError(null);
    try {
      if (!address || !publicClient) throw new Error("Connect the approved deployer wallet first.");
      if (!correctOwner) throw new Error(`Wrong wallet. Connect ${OWNER}.`);
      if (!riskAccepted) throw new Error("Confirm the deployment safety gate first.");
      if (!onArc) { await switchChainAsync({ chainId: arc.id }); await sleep(700); }
      if (!walletClient) throw new Error("Wallet is not ready on Arc. Try again after the network switches.");
      await checkInfrastructure();

      setDeploying(true);
      setHash(null);
      setContractAddress(null);
      setPairResult(null);
      localStorage.removeItem(STORAGE_KEY);

      const data = encodeDeployData({
        abi: routerAbi,
        bytecode: routerBytecode,
        args: [ARC_USDC, ARCFUN_FACTORY, ARCFUN_V4_ROUTER, FEE_RECIPIENT, OWNER],
      });
      const nonce = await publicClient.getTransactionCount({ address, blockTag: "pending" });
      const predictedAddress = getContractAddress({ from: address, nonce: BigInt(nonce) });
      const estimate = await publicClient.estimateGas({ account: address, data });
      const gas = (estimate * 125n + 99n) / 100n;

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
      if (!(await waitForCode(deployed))) throw new Error("Transaction confirmed, but no router bytecode was found.");
      await validateRouter(deployed);
      setContractAddress(deployed);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ address: deployed, hash: txHash }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Deployment failed.");
    } finally {
      setDeploying(false);
    }
  }

  async function testOfficialPair() {
    setError(null);
    setPairResult(null);
    setTestingPair(true);
    try {
      if (!contractAddress || !publicClient) throw new Error("Deploy V3 first.");
      if (!isAddress(testToken) || !isAddress(testCurve)) throw new Error("Enter valid token and curve addresses.");
      const result = await publicClient.readContract({
        address: contractAddress,
        abi: routerAbi,
        functionName: "isOfficialPair",
        args: [getAddress(testToken), getAddress(testCurve)],
      } as any);
      setPairResult(Boolean(result));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Factory validation test failed.");
    } finally {
      setTestingPair(false);
    }
  }

  function clearSavedRouter() {
    localStorage.removeItem(STORAGE_KEY);
    setHash(null);
    setContractAddress(null);
    setSourceVerified(false);
    setPairResult(null);
    setInfraOk(null);
    setError(null);
  }

  const deployReady = isConnected && correctOwner && onArc && riskAccepted && !deploying;

  return (
    <main className="shell">
      <header className="hero">
        <div className="brandRow"><div className="mark">A</div><div><div className="eyebrow">SCANARC · ARC MAINNET</div><div className="networkPill"><i /> Arc 5042</div></div></div>
        <h1>ScanArc lifecycle router</h1>
        <p>Deploy one ScanArc router for official Arcfun tokens before and after graduation.</p>
      </header>

      <section className="statusGrid">
        <article><span>SCANARC FEE</span><b>0.25%</b><small>25 bps · immutable</small></article>
        <article><span>PAIR ONBOARDING</span><b>AUTO</b><small>Factory authenticated</small></article>
        <article><span>PRE-GRAD</span><b>CURVE</b><small>Canonical bonding curve</small></article>
        <article><span>POST-GRAD</span><b>V4</b><small>Canonical Arcfun router</small></article>
      </section>

      <section className="card stepCard">
        <div className="stepHead"><span className="stepNo">01</span><div><h2>Connect owner</h2><p>Use the approved ScanArc deployment wallet on Arc mainnet.</p></div></div>
        {!isConnected ? (
          <button className="primary" disabled={!injected || isConnecting} onClick={() => injected && connect({ connector: injected })}>{isConnecting ? "Opening wallet…" : "Connect wallet"}</button>
        ) : (
          <div className="walletBox"><div><span>CONNECTED WALLET</span><b className={correctOwner ? "good" : "bad"}>{address}</b></div><button className="ghost compact" onClick={() => disconnect()}>Disconnect</button></div>
        )}
        {isConnected && !correctOwner && <div className="notice danger">Wrong wallet. Connect <code>{OWNER}</code>.</div>}
        {isConnected && correctOwner && !onArc && <button className="primary" disabled={isSwitching} onClick={() => switchChainAsync({ chainId: arc.id })}>{isSwitching ? "Switching…" : "Switch to Arc Mainnet"}</button>}
        {isConnected && correctOwner && onArc && <div className="notice success">✓ Approved owner connected on Arc mainnet.</div>}
      </section>

      <section className="card stepCard">
        <div className="stepHead"><span className="stepNo">02</span><div><h2>Review infrastructure</h2><p>V3 can only call the fixed canonical Arcfun infrastructure below.</p></div></div>
        <div className="details">
          <div><span>Arc USDC</span><code>{ARC_USDC}</code></div>
          <div><span>Arcfun Factory</span><code>{ARCFUN_FACTORY}</code></div>
          <div><span>Arcfun V4 Router</span><code>{ARCFUN_V4_ROUTER}</code></div>
          <div><span>Arcfun V4 Quoter</span><code>{ARCFUN_V4_QUOTER}</code></div>
          <div><span>Fee recipient</span><code>{FEE_RECIPIENT}</code></div>
          <div><span>Owner</span><code>{OWNER}</code></div>
        </div>
        <button className="secondary" disabled={!onArc || !publicClient} onClick={() => checkInfrastructure().catch((e) => setError(e instanceof Error ? e.message : "Infrastructure check failed."))}>Check canonical contracts</button>
        {infraOk === true && <div className="notice success">✓ USDC, Factory, V4 Router and V4 Quoter all have contract code on Arc.</div>}
      </section>

      <section className="card stepCard">
        <div className="stepHead"><span className="stepNo">03</span><div><h2>Deploy Router V3</h2><p>This replaces V1 for new ScanArc integration. It does not upgrade V1 in place.</p></div></div>
        <div className="notice"><b>Old V1:</b> <code>{V1_ROUTER}</code><br />Leave it deployed, but do not use it as the production ScanArc router after V3 is validated.</div>
        <label className="check"><input type="checkbox" checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)} /><span>I reviewed the fixed addresses and understand this is production-oriented beta code, not an independent audit.</span></label>
        {!contractAddress ? <button className="primary deploy" disabled={!deployReady} onClick={deploy}>{deploying ? "Deploying ScanArc Router V3…" : "Deploy ScanArc Router V3"}</button> : <div className="notice success strong">✓ V3 deployed and immutable settings validated.</div>}
        {hash && <a className="linkButton" href={explorerTx(hash)} target="_blank" rel="noreferrer">View deployment transaction ↗</a>}
      </section>

      {contractAddress && <section className="card stepCard">
        <div className="stepHead"><span className="stepNo">04</span><div><h2>Verify source</h2><p>Verify the exact V3 source and constructor values before routing public trades.</p></div></div>
        <div className="contractBox"><span>DEPLOYED V3 ROUTER</span><strong>{contractAddress}</strong></div>
        <div className="verifyMeta"><span>{compilerVersion}</span><span>Optimizer ON</span><span>200 runs</span></div>
        <a className="linkButton" href={explorerAddress(contractAddress)} target="_blank" rel="noreferrer">Open V3 on Arc Explorer ↗</a>
        <label className="check"><input type="checkbox" checked={sourceVerified} onChange={(e) => setSourceVerified(e.target.checked)} /><span>I verified the deployed source/bytecode and constructor settings.</span></label>
      </section>}

      {contractAddress && <section className="card stepCard">
        <div className="stepHead"><span className="stepNo">05</span><div><h2>Test automatic Arc token recognition</h2><p>No per-token setPair transaction. The canonical factory must authenticate each token/curve relationship.</p></div></div>
        <label className="field">Token address<input value={testToken} onChange={(e) => setTestToken(e.target.value)} autoCapitalize="none" autoCorrect="off" /></label>
        <label className="field">Curve address<input value={testCurve} onChange={(e) => setTestCurve(e.target.value)} autoCapitalize="none" autoCorrect="off" /></label>
        <button className="secondary" disabled={!sourceVerified || testingPair} onClick={testOfficialPair}>{testingPair ? "Checking factory…" : "Check official Arcfun pair"}</button>
        {pairResult === true && <div className="notice success strong">✓ Official pair recognized. It can route automatically without owner onboarding.</div>}
        {pairResult === false && <div className="notice danger"><b>Pair was not authenticated.</b> Do not connect production trading yet. The live factory getter needs to be matched exactly before use.</div>}
      </section>}

      <section className="card stepCard">
        <div className="stepHead"><span className="stepNo">06</span><div><h2>What V3 covers</h2><p>One contract, two official trading paths.</p></div></div>
        <div className="details">
          <div><span>Unbonded token</span><strong>buyCurve / sellCurve</strong></div>
          <div><span>Graduated token</span><strong>buyGraduated / sellGraduated</strong></div>
          <div><span>V4 target</span><strong>Fixed canonical router only</strong></div>
          <div><span>Unknown pair</span><strong>Rejected</strong></div>
        </div>
        <div className="notice">The app still needs to obtain the correct Arcfun V4 quote/calldata for graduated tokens. V3 verifies the official pair, limits approval to the exact input, calls only the immutable Arcfun V4 router, and checks actual output balances before paying the user.</div>
      </section>

      {(error || connectError) && <section className="card error"><b>Stopped safely</b><p>{error ?? connectError?.message}</p></section>}
      {contractAddress && <button className="ghost reset" onClick={clearSavedRouter}>Clear saved V3 deployment from this browser</button>}
      <footer>Do not route public funds until the known-pair check passes and a small-value curve buy/sell plus graduated V4 buy/sell have been tested end to end.</footer>
    </main>
  );
}
