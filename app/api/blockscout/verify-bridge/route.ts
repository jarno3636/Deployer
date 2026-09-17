import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { cctpBridgeStandardJsonInput } from "../../../../lib/scanarc-cctp-bridge-verification.generated";

export const runtime = "nodejs";
const CHAIN_ID = 5042;
const COMPILER = "v0.8.30+commit.73712a01";

export async function POST(req: NextRequest) {
  try {
    const key = process.env.BLOCKSCOUT_API_KEY;
    if (!key) return NextResponse.json({ error: "BLOCKSCOUT_API_KEY is missing in Vercel." }, { status: 500 });
    const { address, constructorArguments = "" } = await req.json();
    if (!isAddress(address)) return NextResponse.json({ error: "Valid deployed contract address required." }, { status: 400 });
    const body = new URLSearchParams({
      chain_id: String(CHAIN_ID), module: "contract", action: "verifysourcecode",
      codeformat: "solidity-standard-json-input", contractaddress: address,
      contractname: "contracts/ScanArcCCTPBridgeV1.sol:ScanArcCCTPBridgeV1",
      compilerversion: COMPILER, sourceCode: cctpBridgeStandardJsonInput,
      constructorArguments: String(constructorArguments).replace(/^0x/, ""), apikey: key,
    });
    const res = await fetch("https://api.blockscout.com/v2/api", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${key}` },
      body: body.toString(), cache: "no-store",
    });
    const json = await res.json();
    if (!res.ok || String(json?.status) === "0") return NextResponse.json({ error: json?.result || json?.message || `Blockscout verification failed (${res.status}).` }, { status: 422 });
    return NextResponse.json({ ok: true, message: json?.result || json?.message || "CCTP bridge verification submitted." });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Verification submission failed." }, { status: 500 });
  }
}
