"use client";

import { useEffect, useMemo, useState } from "react";
import { encodeAbiParameters, encodeDeployData, getAddress, getContractAddress, isAddress } from "viem";
import { useAccount, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { arc, ARC_RPC_URLS } from "../lib/arc";
import {
  cctpBridgeV2Abi,
  cctpBridgeV2Bytecode,
  cctpBridgeV2CompilerVersion,
} from "../lib/scanarc-cctp-bridge-v2.generated";

const OWNER = getAddress("0x25BE27a17580F59206061B8823E3c0FbC1F7c52E");
const FEE_RECIPIENT = OWNER;
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const TOKEN_MESSENGER_V2 = getAddress("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
const LOCAL_DOMAIN = 26;
const DESTINATION_DOMAINS = [0, 1, 2, 3, 6, 7, 10, 11, 13, 14, 15, 16, 19] as const;
const EXISTING_V1 = getAddress("0x777Fa929eA77a42aF8cb974d6C3e013D79cc1cfD");
const EXISTING_ARC_WIDE_ROUTER = getAddress("0x303c8889930187a7b11280292055dd1364552d29");
const LEGACY_V5 = getAddress("0x2E42f2daE317be31F8859ff000efaFD67dbb245F");
const STORAGE_KEY = "scanarc-cctp-bridge-v2:arc-mainnet";
const FORWARDING_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function explorerAddress(address: string) { return `${arc.blockExplorers.default.url}/address/${address}`; }
function explorerTx(hash: string) { return `${arc.blockExplorers.default.url}/tx/${hash}`; }

export function BridgeV2Deployer() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync, reset: resetConnect } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { data: walletClient } = useWalletClient({ chainId: arc.id });
  const publicClient = usePublicClient({ chainId: arc.id });
  const injected = useMemo(() => connectors.find((connector) => connector.id === "injected"), [connectors]);

  const [walletOpening, setWalletOpening] = useState(false);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [bridgeAddress, setBridgeAddress] = useState<`0x${string}` | null>(null);
  const [verifyState, setVerifyState] = useState<"idle" | "submitting" | "submitted" | "error">("idle");
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const correctOwner = !!address && address.toLowerCase() === OWNER.toLowerCase();
  const onArc = chainId === arc.id;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (isAddress(parsed?.address)) setBridgeAddress(getAddress(parsed.address));
      if (/^0x[0-9a-fA-F]{64}$/.test(parsed?.hash ?? "")) setTxHash(parsed.hash);
    } catch { /* ignore malformed local state */ }
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
          params: [{
            chainId: `0x${arc.id.toString(16)}`,
            chainName: arc.name,
            nativeCurrency: arc.nativeCurrency,
            rpcUrls: [...ARC_RPC_URLS],
            blockExplorerUrls: [arc.blockExplorers.default.url],
          }],
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not repair Arc network.");
    }
  }

  function constructorArgs() {
    return [
      OWNER,
      FEE_RECIPIENT,
      ARC_USDC,
      TOKEN_MESSENGER_V2,
      LOCAL_DOMAIN,
      [...DESTINATION_DOMAINS],
    ] as const;
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

  async function validateV2(target: `0x${string}`) {
    if (!publicClient) throw new Error("Validation client is not ready.");
    const read = (functionName: string, args?: readonly unknown[]) => publicClient.readContract({
      address: target,
      abi: cctpBridgeV2Abi,
      functionName: functionName as any,
      args: args as any,
    });

    const [owner, feeRecipient, usdc, messenger, localDomain, version, feeBps, threshold, hook] = await Promise.all([
      read("owner"),
      read("feeRecipient"),
      read("USDC"),
      read("TOKEN_MESSENGER_V2"),
      read("LOCAL_DOMAIN"),
      read("VERSION"),
      read("FEE_BPS"),
      read("MIN_FINALITY_THRESHOLD"),
      read("FORWARDING_HOOK_DATA"),
    ]);

    if (String(owner).toLowerCase() !== OWNER.toLowerCase()) throw new Error("V2 owner validation failed.");
    if (String(feeRecipient).toLowerCase() !== FEE_RECIPIENT.toLowerCase()) throw new Error("V2 fee recipient validation failed.");
    if (String(usdc).toLowerCase() !== ARC_USDC.toLowerCase()) throw new Error("V2 USDC validation failed.");
    if (String(messenger).toLowerCase() !== TOKEN_MESSENGER_V2.toLowerCase()) throw new Error("V2 TokenMessenger validation failed.");
    if (Number(localDomain) !== LOCAL_DOMAIN) throw new Error("V2 local domain validation failed.");
    if (BigInt(String(version)) !== 2n) throw new Error("V2 version validation failed.");
    if (BigInt(String(feeBps)) !== 25n) throw new Error("V2 fee validation failed.");
    if (Number(threshold) !== 2000) throw new Error("V2 finality validation failed.");
    if (String(hook).toLowerCase() !== FORWARDING_HOOK.toLowerCase()) throw new Error("V2 forwarding hook validation failed.");

    for (const domain of DESTINATION_DOMAINS) {
      const enabled = await read("destinationEnabled", [domain]);
      if (enabled !== true) throw new Error(`Destination domain ${domain} is not enabled.`);
    }
  }

  async function deployV2() {
    setError(null);
    try {
      if (!address || !publicClient) throw new Error("Connect the owner wallet first.");
      if (!correctOwner) throw new Error(`Wrong wallet. Connect ${OWNER}.`);
      if (!riskAccepted) throw new Error("Confirm the V2 forwarding deployment model first.");
      if (!onArc) { await switchChainAsync({ chainId: arc.id }); await sleep(700); }
      if (!walletClient) throw new Error("Wallet is not ready on Arc.");

      setDeploying(true);
      setTxHash(null);
      setBridgeAddress(null);
      setVerifyState("idle");
      localStorage.removeItem(STORAGE_KEY);

      const data = encodeDeployData({ abi: cctpBridgeV2Abi, bytecode: cctpBridgeV2Bytecode, args: constructorArgs() as any });
      const nonce = await publicClient.getTransactionCount({ address, blockTag: "pending" });
      const predictedAddress = getContractAddress({ from: address, nonce: BigInt(nonce) });
      const hash = await walletClient.sendTransaction({ account: address, chain: arc, data, gas: 1_600_000n });
      setTxHash(hash);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("ScanArc CCTP Bridge V2 deployment reverted.");

      const deployed = receipt.contractAddress ?? predictedAddress;
      if (!(await waitForCode(deployed))) throw new Error("V2 bytecode was not found after confirmation.");
      await validateV2(deployed);

      setBridgeAddress(deployed);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ address: deployed, hash }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "V2 deployment failed.");
    } finally {
      setDeploying(false);
    }
  }

  async function verifyV2() {
    setError(null);
    setVerifyState("submitting");
    setVerifyMessage(null);
    try {
      if (!bridgeAddress) throw new Error("Deploy CCTP Bridge V2 first.");
      const encoded = encodeAbiParameters(
        [
          { type: "address" },
          { type: "address" },
          { type: "address" },
          { type: "address" },
          { type: "uint32" },
          { type: "uint32[]" },
        ],
        constructorArgs() as any,
      );

      const res = await fetch("/api/blockscout/verify-bridge-v2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: bridgeAddress, constructorArguments: encoded.slice(2) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "V2 verification failed.");

      setVerifyState("submitted");
      setVerifyMessage(json?.message || "V2 verification submitted.");
    } catch (cause) {
      setVerifyState("error");
      setError(cause instanceof Error ? cause.message : "V2 verification failed.");
    }
  }

  function clearSavedV2() {
    localStorage.removeItem(STORAGE_KEY);
    setTxHash(null);
    setBridgeAddress(null);
    setVerifyState("idle");
    setVerifyMessage(null);
    setError(null);
  }

  return <main className="shell">
    <header className="hero">
      <div className="brandRow"><div className="mark">A</div><div><div className="eyebrow">SCANARC · ARC MAINNET</div><div className="networkPill"><i /> Arc 5042</div></div></div>
      <h1>CCTP Bridge V2</h1>
      <p>One new Arc-side USDC adapter with Circle Forwarding Service. The destination mint is forwarded automatically instead of requiring a final destination-wallet action.</p>
    </header>

    <section className="statusGrid">
      <article><span>NEW DEPLOYMENTS</span><b>1</b><small>Bridge V2 only</small></article>
      <article><span>SCANARC FEE</span><b>0.25%</b><small>USDC → fee wallet</small></article>
      <article><span>DESTINATION ACTION</span><b>AUTO</b><small>Circle forwarding</small></article>
      <article><span>OLDER CONTRACTS</span><b>KEEP</b><small>No redeploys</small></article>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">01</span><div><h2>Connect owner</h2><p>Deploy only from the existing ScanArc owner wallet.</p></div></div>
      {!isConnected ? <button className="primary" disabled={!injected || walletOpening} onClick={connectOwnerWallet}>{walletOpening ? "Opening wallet…" : "Connect wallet"}</button> : <div className="walletBox"><div><span>CONNECTED WALLET</span><b className={correctOwner ? "good" : "bad"}>{address}</b></div><button className="ghost compact" onClick={() => disconnect()}>Disconnect</button></div>}
      {isConnected && !correctOwner && <div className="notice danger">Wrong wallet. Connect <code>{OWNER}</code>.</div>}
      {isConnected && correctOwner && !onArc && <button className="primary" disabled={isSwitching} onClick={() => switchChainAsync({ chainId: arc.id })}>{isSwitching ? "Switching…" : "Switch to Arc Mainnet"}</button>}
      {isConnected && correctOwner && onArc && <div className="notice success">✓ Approved owner connected on Arc.</div>}
      <button className="secondary" disabled={!isConnected} onClick={repairWalletArcNetwork}>Repair Arc network in wallet</button>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">02</span><div><h2>Preserve existing deployments</h2><p>V2 is additive. No router, V1 bridge, registry, or legacy contract is redeployed.</p></div></div>
      <div className="details">
        <div><span>Bridge V1</span><code>{EXISTING_V1}</code></div>
        <div><span>Arc-Wide Router</span><code>{EXISTING_ARC_WIDE_ROUTER}</code></div>
        <div><span>Legacy V5</span><code>{LEGACY_V5}</code></div>
      </div>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">03</span><div><h2>Fixed production configuration</h2><p>All required destination domains are passed in the constructor. There is no follow-up initialization transaction.</p></div></div>
      <div className="details">
        <div><span>Owner</span><code>{OWNER}</code></div>
        <div><span>Fee recipient</span><code>{FEE_RECIPIENT}</code></div>
        <div><span>Arc USDC</span><code>{ARC_USDC}</code></div>
        <div><span>TokenMessenger</span><code>{TOKEN_MESSENGER_V2}</code></div>
        <div><span>Arc domain</span><strong>26</strong></div>
        <div><span>Destinations</span><strong>{DESTINATION_DOMAINS.join(", ")}</strong></div>
        <div><span>Finality</span><strong>2000 · Standard</strong></div>
        <div><span>Forward hook</span><code>{FORWARDING_HOOK}</code></div>
      </div>
      <div className="notice strong">Circle currently lists Forwarding Service support for Arc and marks Fast Transfer as N/A for Arc source. V2 therefore uses Standard finality and forwarding.</div>
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">04</span><div><h2>Deploy CCTP Bridge V2</h2><p>This is the only new on-chain deployment in this flow.</p></div></div>
      <label className="check"><input type="checkbox" checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)} /><span>I understand V2 replaces V1 only in the ScanArc frontend after testing; V1 remains deployed and untouched.</span></label>
      <button className="primary deploy" disabled={!isConnected || !correctOwner || !onArc || !riskAccepted || deploying} onClick={deployV2}>{deploying ? "Deploying Bridge V2…" : "Deploy CCTP Bridge V2"}</button>
      {txHash && <a className="linkButton" href={explorerTx(txHash)} target="_blank" rel="noreferrer">Open deployment transaction</a>}
      {bridgeAddress && <div className="notice success">✓ V2 deployed and validated at <code>{bridgeAddress}</code></div>}
    </section>

    <section className="card stepCard">
      <div className="stepHead"><span className="stepNo">05</span><div><h2>Verify on Blockscout</h2><p>Uses the exact Standard JSON input generated by the same compiler used for deployment bytecode.</p></div></div>
      <div className="verifyMeta"><span>{cctpBridgeV2CompilerVersion}</span><span>optimizer 200</span><span>Solidity standard JSON</span></div>
      <button className="primary" disabled={!bridgeAddress || verifyState === "submitting"} onClick={verifyV2}>{verifyState === "submitting" ? "Submitting verification…" : "Verify CCTP Bridge V2"}</button>
      {bridgeAddress && <a className="linkButton" href={explorerAddress(bridgeAddress)} target="_blank" rel="noreferrer">Open V2 contract</a>}
      {verifyMessage && <div className="notice success">{verifyMessage}</div>}
      <button className="ghost reset" onClick={clearSavedV2}>Clear saved V2 deployment from this browser</button>
    </section>

    {error && <section className="card error"><b>Action stopped</b><p>{error}</p></section>}

    <footer>
      Bridge V2 uses Circle's reserved <code>cctp-forward</code> hook. The ScanArc application must request a live Circle forwarding fee quote immediately before calling <code>bridgeUSDC</code>; do not hard-code <code>maxCircleFee</code>.
    </footer>
  </main>;
}
