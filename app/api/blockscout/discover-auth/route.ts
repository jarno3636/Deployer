import { NextRequest, NextResponse } from "next/server";
import { encodeAbiParameters, isAddress, keccak256, toBytes } from "viem";

export const runtime = "nodejs";
const CHAIN_ID = 5042;
const FACTORY = "0xBBf81Fd835B471C86d094eAaD35BB10068a987f8";

function selector(signature: string): `0x${string}` {
  return keccak256(toBytes(signature)).slice(0, 10) as `0x${string}`;
}
function wordAddress(data: string) {
  if (!/^0x[0-9a-fA-F]{64,}$/.test(data)) return null;
  return `0x${data.slice(-40)}`.toLowerCase();
}
function wordBool(data: string) {
  if (!/^0x[0-9a-fA-F]{64,}$/.test(data)) return null;
  return BigInt(data) !== 0n;
}
async function rpcCall(key: string, to: string, data: string) {
  const res = await fetch(`https://api.blockscout.com/${CHAIN_ID}/json-rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    cache: "no-store",
  });
  const json = await res.json();
  return typeof json?.result === "string" ? json.result : null;
}
async function getAbi(key: string, address: string): Promise<any[]> {
  const v2 = await fetch(`https://api.blockscout.com/${CHAIN_ID}/api/v2/smart-contracts/${address}`, {
    headers: { authorization: `Bearer ${key}` }, cache: "no-store",
  });
  if (v2.ok) {
    const json = await v2.json();
    if (Array.isArray(json?.abi)) return json.abi;
  }
  const legacy = await fetch(`https://api.blockscout.com/v2/api?chain_id=${CHAIN_ID}&module=contract&action=getsourcecode&address=${address}&apikey=${encodeURIComponent(key)}`, { cache: "no-store" });
  if (!legacy.ok) throw new Error(`Blockscout ABI lookup failed (${legacy.status}).`);
  const json = await legacy.json();
  const raw = json?.result?.[0]?.ABI;
  if (!raw || raw === "Contract source code not verified") throw new Error(`Verified ABI is unavailable for ${address}.`);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function POST(req: NextRequest) {
  try {
    const key = process.env.BLOCKSCOUT_API_KEY;
    if (!key) return NextResponse.json({ error: "BLOCKSCOUT_API_KEY is missing in Vercel." }, { status: 500 });
    const { token, curve } = await req.json();
    if (!isAddress(token) || !isAddress(curve)) return NextResponse.json({ error: "Valid token and curve addresses are required." }, { status: 400 });
    const tokenLc = token.toLowerCase();
    const curveLc = curve.toLowerCase();
    // Only the canonical factory needs a verified ABI. Individual bonding curves
    // may be unverified on Blockscout even when they are legitimate factory deployments.
    const factoryAbi = await getAbi(key, FACTORY);

    const oneAddressFactoryFns = factoryAbi.filter((x: any) => x?.type === "function" && ["view", "pure"].includes(x.stateMutability) && x.inputs?.length === 1 && x.inputs[0]?.type === "address" && x.outputs?.length >= 1 && ["address", "bool"].includes(x.outputs[0]?.type));

    for (const fn of oneAddressFactoryFns) {
      const sig = `${fn.name}(address)`;
      const sel = selector(sig);
      const tokenData = `${sel}${encodeAbiParameters([{ type: "address" }], [token]).slice(2)}`;
      const out = await rpcCall(key, FACTORY, tokenData);
      if (fn.outputs[0].type === "address" && out && wordAddress(out) === curveLc) {
        return NextResponse.json({ mode: 1, factorySelector: sel, curveTokenSelector: "0x00000000", factoryFunction: sig, proof: "factory(token) = curve" });
      }
    }

    for (const fn of oneAddressFactoryFns) {
      const sig = `${fn.name}(address)`;
      const sel = selector(sig);
      const curveData = `${sel}${encodeAbiParameters([{ type: "address" }], [curve]).slice(2)}`;
      const out = await rpcCall(key, FACTORY, curveData);
      if (fn.outputs[0].type === "address" && out && wordAddress(out) === tokenLc) {
        return NextResponse.json({ mode: 2, factorySelector: sel, curveTokenSelector: "0x00000000", factoryFunction: sig, proof: "factory(curve) = token" });
      }
    }

    // Some legitimate Arcfun bonding curves are not individually verified on Blockscout.
    // For a factory boolean registry (factory(curve) => true), safely probe a small
    // read-only set of common zero-argument token getters directly on the known curve.
    // The selector that proves the known official pair is then locked into Router V4.
    const curveTokenSignatures = [
      "token()",
      "TOKEN()",
      "asset()",
      "saleToken()",
      "baseToken()",
      "tokenAddress()",
      "getToken()",
      "erc20()",
    ];

    for (const factoryFn of oneAddressFactoryFns.filter((x: any) => x.outputs[0].type === "bool")) {
      const fsig = `${factoryFn.name}(address)`;
      const fsel = selector(fsig);
      const fdata = `${fsel}${encodeAbiParameters([{ type: "address" }], [curve]).slice(2)}`;
      const fout = await rpcCall(key, FACTORY, fdata);
      if (!fout || wordBool(fout) !== true) continue;

      for (const csig of curveTokenSignatures) {
        const csel = selector(csig);
        const cout = await rpcCall(key, curve, csel);
        if (cout && wordAddress(cout) === tokenLc) {
          return NextResponse.json({
            mode: 3,
            factorySelector: fsel,
            curveTokenSelector: csel,
            factoryFunction: fsig,
            curveFunction: csig,
            proof: "factory(curve)=true + curve getter returns token",
          });
        }
      }
    }

    return NextResponse.json({ error: "No verified on-chain factory relationship matched this known pair. V4 deployment is intentionally blocked." }, { status: 422 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Authentication discovery failed." }, { status: 500 });
  }
}
