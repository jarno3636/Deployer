import { NextResponse } from "next/server";
import { isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const runtime = "nodejs";

function signer() {
  const raw = process.env.SCANARC_ATTESTER_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("SCANARC_ATTESTER_PRIVATE_KEY is missing in Vercel.");
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  if (!isHex(key) || key.length !== 66) throw new Error("SCANARC_ATTESTER_PRIVATE_KEY must be a 32-byte private key.");
  return privateKeyToAccount(key);
}

export async function GET() {
  try {
    const account = signer();
    return NextResponse.json({ address: account.address });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Attester configuration failed." }, { status: 500 });
  }
}
