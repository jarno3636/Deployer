import {NextRequest,NextResponse} from 'next/server';
import {createPublicClient,http,isAddress,parseAbi,getAddress} from 'viem';
import {base} from 'viem/chains';
export const runtime='nodejs';export const dynamic='force-dynamic';
const ABI=parseAbi(['function inspectPath(address tokenIn,address tokenOut,address[] path,uint256 deadline) view returns (bool)','function dexRouter() view returns (address)','function callerRouter() view returns (address)']);
export async function POST(req:NextRequest){try{
 const b=await req.json();
 if(!isAddress(b.adapter)||!isAddress(b.tokenIn)||!isAddress(b.tokenOut)||!Array.isArray(b.path)||b.path.length<2||b.path.length>4||!b.path.every((x:unknown)=>typeof x==='string'&&isAddress(x)))return NextResponse.json({error:'Invalid address or path (2–4 tokens)'},{status:400});
 const deadline=BigInt(b.deadline);if(deadline<=0n)return NextResponse.json({error:'Invalid deadline'},{status:400});
 const client=createPublicClient({chain:base,transport:http(process.env.BASE_RPC_URL||process.env.NEXT_PUBLIC_BASE_RPC_URL||'https://mainnet.base.org',{timeout:12000})});
 const adapter=getAddress(b.adapter);if(!(await client.getCode({address:adapter})))return NextResponse.json({error:'Adapter not deployed'},{status:400});
 const [compatible,dexRouter,callerRouter]=await Promise.all([client.readContract({address:adapter,abi:ABI,functionName:'inspectPath',args:[getAddress(b.tokenIn),getAddress(b.tokenOut),b.path.map((x:string)=>getAddress(x)),deadline]}),client.readContract({address:adapter,abi:ABI,functionName:'dexRouter'}),client.readContract({address:adapter,abi:ABI,functionName:'callerRouter'})]);
 return NextResponse.json({compatible,dexRouter,callerRouter,chainId:8453,warning:'Structural check only. Does not establish liquidity, taxes, quote, simulation or execution.'});
}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Test failed'},{status:502});}}
