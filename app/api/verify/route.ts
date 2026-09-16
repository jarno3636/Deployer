import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Arc source verification is handled through Arc Explorer after deployment.
// This route intentionally does not reuse the old Base/Etherscan verification flow.
export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: 'Automatic Arc verification is not configured. Use the Arc Explorer verification link shown by the deployer.',
    },
    { status: 501 },
  );
}
