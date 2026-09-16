import { useEffect, useMemo, useState } from "react";
import { encodeDeployData, getAddress, getContractAddress, isAddress } from "viem";
import { useAccount, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { arc } from "./lib/arc";
import { routerAbi, routerBytecode, compilerVersion } from "./lib/scanarc-router.generated";

const OWNER = getAddress("0x25BE27a17580F59206061B8823E3c0FbC1F7c52E");
const FEE_RECIPIENT = OWNER;
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const INITIAL_TOKEN = "0x305bf34dea03a0fb2bd7a24295f00d8163601aae";
const INITIAL_CURVE = "0x4beec7f96c0582e1e573d16aa113d6fe01864029";
const STORAGE_KEY = "scanarc-router:arc-mainnet:v1";

function short(value?: string) {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function explorerAddress(address: string) {
  return `${arc.blockExplorers.default.url}/address/${address}`;
}

function explorerTx(hash: string) {
  return `${arc.blockExplorers.default.url}/tx/${hash}`;
}

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
  const [token, setToken] = useState(INITIAL_TOKEN);
  const [curve, setCurve] = useState(INITIAL_CURVE);
  const [pairConfirmed, setPairConfirmed] = useState(false);
  const [sourceVerified, setSourceVerified] = useState(false);
  const [pairHash, setPairHash] = useState<`0x${string}` | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairRegistered, setPairRegistered] = useState(false);

  const onArc = chainId === arc.id;
  const correctOwner = address?.toLowerCase() === OWNER.toLowerCase();

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as { address?: `0x${string}`; hash?: `0x${string}` };
      if (parsed.address && isAddress(parsed.address)) setContractAddress(getAddress(parsed.address));
      if (parsed.hash) setHash(parsed.hash);
    } catch {
      // Ignore stale local state. Onchain validation still gates pair registration.
    }
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

  async function validateRouter(target: `0x${string}`) {
    if (!publicClient) throw new Error("Arc RPC is unavailable.");
    const [owner, recipient, fee, usdc, pendingOwner] = await Promise.all([
      publicClient.readContract({ address: target, abi: routerAbi, functionName: "owner" }),
      publicClient.readContract({ address: target, abi: routerAbi, functionName: "feeRecipient" }),
      publicClient.readContract({ address: target, abi: routerAbi, functionName: "FEE_BPS" }),
      publicClient.readContract({ address: target, abi: routerAbi, functionName: "usdc" }),
      publicClient.readContract({ address: target, abi: routerAbi, functionName: "pendingOwner" }),
    ]);

    if (String(owner).toLowerCase() !== OWNER.toLowerCase()) throw new Error("Router owner validation failed.");
    if (String(recipient).toLowerCase() !== FEE_RECIPIENT.toLowerCase()) throw new Error("Fee recipient validation failed.");
    if (fee !== 25n) throw new Error("Fee validation failed. Expected 25 bps.");
    if (String(usdc).toLowerCase() !== ARC_USDC.toLowerCase()) throw new Error("Arc USDC validation failed.");
    if (String(pendingOwner).toLowerCase() !== "0x0000000000000000000000000000000000000000") {
      throw new Error("Unexpected pending owner detected.");
    }
  }

  async function deploy() {
    setError(null);
    setPairRegistered(false);
    try {
      if (!address || !publicClient) throw new Error("Connect the approved deployer wallet first.");
      if (!correctOwner) throw new Error(`Wrong wallet. Connect ${OWNER}.`);
      if (!riskAccepted) throw new Error("Confirm the deployment safety gate first.");
      if (!onArc) {
        await switchChainAsync({ chainId: arc.id });
        await sleep(700);
      }
      if (!walletClient) throw new Error("Wallet is not ready on Arc. Try again after the network switches.");

      const usdcCode = await publicClient.getBytecode({ address: ARC_USDC });
      if (!usdcCode || usdcCode === "0x") {
        throw new Error("Arc USDC contract validation failed. Do not deploy until the network/address is re-checked.");
      }

      setDeploying(true);
      setHash(null);
      setContractAddress(null);
      localStorage.removeItem(STORAGE_KEY);

      const data = encodeDeployData({
        abi: routerAbi,
        bytecode: routerBytecode,
        args: [ARC_USDC, FEE_RECIPIENT, OWNER],
      });

      const nonce = await publicClient.getTransactionCount({ address, blockTag: "pending" });
      const predictedAddress = getContractAddress({ from: address, nonce: BigInt(nonce) });
      const estimate = await publicClient.estimateGas({ account: address, data });
      const gas = (estimate * 120n + 99n) / 100n;

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

  async function registerPair() {
    setError(null);
    setPairHash(null);
    setPairRegistered(false);
    try {
      if (!contractAddress || !walletClient || !publicClient || !address) throw new Error("Deploy and validate the router first.");
      if (!correctOwner) throw new Error(`Wrong wallet. Connect ${OWNER}.`);
      if (!onArc) throw new Error("Switch to Arc mainnet first.");
      if (!sourceVerified) throw new Error("Verify the deployed router source before enabling a live pair.");
      if (!pairConfirmed) throw new Error("Confirm that the token and curve pair was independently verified.");
      if (!isAddress(token) || !isAddress(curve)) throw new Error("Enter valid token and curve addresses.");

      const tokenAddress = getAddress(token);
      const curveAddress = getAddress(curve);
      const [tokenCode, curveCode] = await Promise.all([
        publicClient.getBytecode({ address: tokenAddress }),
        publicClient.getBytecode({ address: curveAddress }),
      ]);
      if (!tokenCode || tokenCode === "0x" || !curveCode || curveCode === "0x") {
        throw new Error("Token or curve has no contract code on Arc.");
      }

      await validateRouter(contractAddress);
      setPairBusy(true);
      const tx = await walletClient.writeContract({
        account: address,
        chain: arc,
        address: contractAddress,
        abi: routerAbi,
        functionName: "setPair",
        args: [tokenAddress, curveAddress, true],
      });
      setPairHash(tx);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== "success") throw new Error("Pair registration reverted.");

      const allowed = await publicClient.readContract({
        address: contractAddress,
        abi: routerAbi,
        functionName: "allowedPair",
        args: [tokenAddress, curveAddress],
      });
      if (!allowed) throw new Error("Transaction confirmed, but the pair did not read back as enabled.");
      setPairRegistered(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pair registration failed.");
    } finally {
      setPairBusy(false);
    }
  }

  function clearSavedRouter() {
    localStorage.removeItem(STORAGE_KEY);
    setHash(null);
    setContractAddress(null);
    setSourceVerified(false);
    setPairConfirmed(false);
    setPairHash(null);
    setPairRegistered(false);
    setError(null);
  }

  const deployReady = isConnected && correctOwner && onArc && riskAccepted && !deploying;

  return (
    <main className="shell">
      <header className="hero">
        <div className="brandRow">
          <div className="mark">A</div>
          <div><div className="eyebrow">SCANARC · ARC MAINNET</div><div className="networkPill"><i /> Arc 5042</div></div>
        </div>
        <h1>Router deployment console</h1>
        <p>Deploy the reviewed ScanArc routing adapter, validate its immutable settings, then register only verified Arcfun pairs.</p>
      </header>

      <section className="statusGrid">
        <article><span>ROUTER FEE</span><b>0.25%</b><small>25 bps · immutable</small></article>
        <article><span>OWNER</span><b>{short(OWNER)}</b><small>Approved deployer</small></article>
        <article><span>SETTLEMENT</span><b>USDC</b><small>{short(ARC_USDC)}</small></article>
        <article><span>COMPILER</span><b>{compilerVersion}</b><small>Optimizer · 200 runs</small></article>
      </section>

      <section className="card stepCard">
        <div className="stepHead"><span className="stepNo">01</span><div><h2>Connect deployer</h2><p>Only the approved owner wallet can deploy or configure ScanArc.</p></div></div>
        {!isConnected ? (
          <button className="primary" disabled={!injected || isConnecting} onClick={() => injected && connect({ connector: injected })}>
            {isConnecting ? "Opening wallet…" : "Connect MetaMask"}
          </button>
        ) : (
          <div className="walletBox">
            <div><span>CONNECTED WALLET</span><b className={correctOwner ? "good" : "bad"}>{address}</b></div>
            <button className="ghost compact" onClick={() => disconnect()}>Disconnect</button>
          </div>
        )}
        {isConnected && !correctOwner && <div className="notice danger">Wrong wallet. Connect <code>{OWNER}</code>.</div>}
        {isConnected && correctOwner && !onArc && (
          <button className="primary" disabled={isSwitching} onClick={() => switchChainAsync({ chainId: arc.id })}>
            {isSwitching ? "Switching…" : "Switch to Arc Mainnet"}
          </button>
        )}
        {isConnected && correctOwner && onArc && <div className="notice success">✓ Approved owner connected on Arc mainnet.</div>}
      </section>

      <section className="card stepCard">
        <div className="stepHead"><span className="stepNo">02</span><div><h2>Review & deploy</h2><p>The constructor is locked to the Arc USDC, fee recipient, and owner shown below.</p></div></div>
        <div className="details">
          <div><span>Arc USDC</span><code>{ARC_USDC}</code></div>
          <div><span>Fee recipient</span><code>{FEE_RECIPIENT}</code></div>
          <div><span>Owner</span><code>{OWNER}</code></div>
          <div><span>Value sent</span><strong>0 USDC</strong></div>
        </div>
        <label className="check"><input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} /><span>I reviewed these fixed values and understand compilation is not an independent security audit.</span></label>
        {!contractAddress ? (
          <button className="primary deploy" disabled={!deployReady} onClick={deploy}>{deploying ? "Deploying ScanArc Router…" : "Deploy ScanArc Router"}</button>
        ) : (
          <div className="notice success strong">✓ Router deployed and onchain settings validated.</div>
        )}
        {hash && <a className="linkButton" href={explorerTx(hash)} target="_blank" rel="noreferrer">View deployment transaction ↗</a>}
      </section>

      {contractAddress && (
        <section className="card stepCard">
          <div className="stepHead"><span className="stepNo">03</span><div><h2>Verify source</h2><p>Verify the exact ScanArcRouter source before enabling live routing.</p></div></div>
          <div className="contractBox"><span>DEPLOYED ROUTER</span><strong>{contractAddress}</strong></div>
          <div className="verifyMeta"><span>Solidity 0.8.30</span><span>Optimizer ON</span><span>200 runs</span></div>
          <a className="linkButton" href={explorerAddress(contractAddress)} target="_blank" rel="noreferrer">Open router on Arc Explorer ↗</a>
          <label className="check"><input type="checkbox" checked={sourceVerified} onChange={(event) => setSourceVerified(event.target.checked)} /><span>I verified that the deployed source/bytecode and constructor settings match this build.</span></label>
        </section>
      )}

      {contractAddress && (
        <section className="card stepCard">
          <div className="stepHead"><span className="stepNo">04</span><div><h2>Register Arcfun pair</h2><p>This is a separate owner transaction. Never enable an unverified token/curve pair.</p></div></div>
          <label className="field">Token address<input value={token} onChange={(event) => setToken(event.target.value)} autoCapitalize="none" autoCorrect="off" /></label>
          <label className="field">Curve address<input value={curve} onChange={(event) => setCurve(event.target.value)} autoCapitalize="none" autoCorrect="off" /></label>
          <div className="candidate">Pre-filled candidate: <b>STOW</b>. Confirm both addresses independently before signing.</div>
          <label className="check"><input type="checkbox" checked={pairConfirmed} onChange={(event) => setPairConfirmed(event.target.checked)} /><span>I independently verified this exact token and curve pairing on Arc.</span></label>
          <button className="secondary" disabled={!sourceVerified || !pairConfirmed || pairBusy} onClick={registerPair}>{pairBusy ? "Registering pair…" : "Enable verified pair"}</button>
          {pairHash && <a className="linkButton" href={explorerTx(pairHash)} target="_blank" rel="noreferrer">View pair transaction ↗</a>}
          {pairRegistered && <div className="notice success">✓ Pair is enabled and confirmed onchain.</div>}
        </section>
      )}

      {(error || connectError) && <section className="card error"><b>Stopped safely</b><p>{error ?? connectError?.message}</p></section>}

      {contractAddress && <button className="ghost reset" onClick={clearSavedRouter}>Clear saved deployment from this browser</button>}

      <footer>
        ScanArc routes only owner-approved token/curve pairs. Keep direct venue links active until source verification, independent review, and small-value buy/sell testing are complete.
      </footer>
    </main>
  );
}
