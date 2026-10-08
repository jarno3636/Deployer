import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, getAddress, http, isAddress, parseAbi } from 'viem';
import { base } from 'viem/chains';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ABI = parseAbi(['function inspectRoute(address target,address spender,bytes4 selector) view returns (bool targetOk,bool spenderOk,bool selectorOk,bool pairOk,bool executable)', 'function callerRouter() view returns (address)', 'function RELEASE_ID() view returns (bytes32)']);
const RPC = process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org';
export async function POST(req: NextRequest) {
  try {
    const b = await req.json() as Record<string,unknown>;
    for (const k of ['adapter','target','spender']) if (typeof b[k] !== 'string' || !isAddress(b[k] as string)) return NextResponse.json({error:`Invalid ${k}`},{status:400});
    if (typeof b.selector !== 'string' || !/^0x[0-9a-fA-F]{8}$/.test(b.selector)) return NextResponse.json({error:'Invalid selector'},{status:400});
    const client = createPublicClient({chain:base,transport:http(RPC,{timeout:12000})});
    const adapter=getAddress(b.adapter as string),target=getAddress(b.target as string),spender=getAddress(b.spender as string);
    const code=await client.getCode({address:adapter});
    if(!code || code==='0x') return NextResponse.json({error:'Adapter not deployed on Base'},{status:400});
    const [checks,router,release] = await Promise.all([
      client.readContract({address:adapter,abi:ABI,functionName:'inspectRoute',args:[target,spender,b.selector as `0x${string}`]}),
      client.readContract({address:adapter,abi:ABI,functionName:'callerRouter'}),
      client.readContract({address:adapter,abi:ABI,functionName:'RELEASE_ID'}),
    ]);
    return NextResponse.json({chainId:8453,adapter,router,release,checks:{targetOk:checks[0],spenderOk:checks[1],selectorOk:checks[2],pairOk:checks[3],executable:checks[4]},warning:'Read-only permissions test. This does not prove calldata correctness, liquidity, tax compatibility, or successful execution.'});
  } catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Route test failed'},{status:502});}
}
