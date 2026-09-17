import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { proveArcfunPair } from "../../../../lib/server/scanarc-provenance";

export const runtime = "nodejs";
const CHAIN_ID = 5042;
const MAX_VALIDITY_SECONDS = 24 * 60 * 60;

function signer() {
  const raw = process.env.SCANARC_ATTESTER_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("SCANARC_ATTESTER_PRIVATE_KEY is missing in Vercel.");
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  if (!isHex(key) || key.length !== 66) throw new Error("SCANARC_ATTESTER_PRIVATE_KEY must be a 32-byte private key.");
  return privateKeyToAccount(key);
}

export async function POST(req: NextRequest) {
  try {
    const blockscoutKey = process.env.BLOCKSCOUT_API_KEY;
    if (!blockscoutKey) return NextResponse.json({ error: "BLOCKSCOUT_API_KEY is missing in Vercel." }, { status: 500 });
    const { token, curve, router } = await req.json();
    if (!isAddress(router)) return NextResponse.json({ error: "A valid V5 router address is required." }, { status: 400 });

    const proof = await proveArcfunPair(String(token ?? ""), String(curve ?? ""), blockscoutKey);
    const account = signer();
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + MAX_VALIDITY_SECONDS);
    const verifyingContract = getAddress(router);

    const signature = await account.signTypedData({
      domain: { name: "ScanArcRouter", version: "5", chainId: CHAIN_ID, verifyingContract },
      types: {
        PairAuthorization: [
          { name: "token", type: "address" },
          { name: "curve", type: "address" },
          { name: "validUntil", type: "uint256" },
        ],
      },
      primaryType: "PairAuthorization",
      message: { token: proof.token, curve: proof.curve, validUntil },
    });

    return NextResponse.json({
      token: proof.token,
      curve: proof.curve,
      router: verifyingContract,
      validUntil: validUntil.toString(),
      signature,
      attester: account.address,
      creationTransaction: proof.creationTransaction,
      proof: proof.proof,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Pair attestation failed." }, { status: 422 });
  }
}
