import { NextRequest, NextResponse } from "next/server";
import { proveArcfunPair } from "../../../../lib/server/scanarc-provenance";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const key = process.env.BLOCKSCOUT_API_KEY;
    if (!key) return NextResponse.json({ error: "BLOCKSCOUT_API_KEY is missing in Vercel." }, { status: 500 });
    const { token, curve } = await req.json();
    const proof = await proveArcfunPair(String(token ?? ""), String(curve ?? ""), key);
    return NextResponse.json({ ok: true, ...proof });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Pair provenance check failed." }, { status: 422 });
  }
}
