import {NextRequest,NextResponse} from 'next/server';
import {createPublicClient,http,isAddress,getAddress,encodeAbiParameters,parseAbi,encodeFunctionData} from 'viem';
import {base} from 'viem/chains';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const ABI=parseAbi(['function callerRouter() view returns(address)','function dexRouter() view returns(address)','function inspectPath(address,address,address[],uint256) view returns(bool)','function swapExactInput(address,address,uint256,uint256,address,bytes) returns(uint256)','function approvedAdapter(address) view returns(bool)','function balanceOf(address) view returns(uint256)']);
const RPC=process.env.BASE_RPC_URL||process.env.NEXT_PUBLIC_BASE_RPC_URL||'https://mainnet.base.org';
const address=(v:unknown)=>typeof v==='string'&&isAddress(v)?getAddress(v):null;
const bad=(reason:string,status=400)=>NextResponse.json({error:reason},{status});
export async function POST(req:NextRequest){try{
 const b=await req.json();const adapter=address(b.adapter),tokenIn=address(b.tokenIn),tokenOut=address(b.tokenOut),recipient=address(b.recipient);
 const path: (`0x${string}` | null)[] = Array.isArray(b.path) ? (b.path as unknown[]).map(address) : [];
 if(!adapter||!tokenIn||!tokenOut||!recipient||path.length<2||path.length>4||path.some(x=>!x))return bad('Invalid addresses or path');
 if(typeof b.amountIn!=='string'||typeof b.minOut!=='string'||!/^[0-9]+$/.test(b.amountIn)||!/^[0-9]+$/.test(b.minOut))return bad('Raw integer amounts required');
 const amountIn=BigInt(b.amountIn),minOut=BigInt(b.minOut);
 if(!amountIn||!minOut||amountIn>10n**60n||minOut>10n**60n)return bad('Amounts must be positive and bounded');
 const client=createPublicClient({chain:base,transport:http(RPC,{timeout:15000})});
 if(!await client.getCode({address:adapter}))return bad('Adapter not deployed on Base');
 const [callerRouter,dexRouter]=await Promise.all([client.readContract({address:adapter,abi:ABI,functionName:'callerRouter'}),client.readContract({address:adapter,abi:ABI,functionName:'dexRouter'})]);
 const deadline=BigInt(Math.floor(Date.now()/1000)+600);
 const normalizedPath=path as `0x${string}`[];
 const compatible=await client.readContract({address:adapter,abi:ABI,functionName:'inspectPath',args:[tokenIn,tokenOut,normalizedPath,deadline]});
 if(!compatible)return NextResponse.json({compatible:false,simulated:false,reason:'Adapter rejected route structure'});
 const approved=await client.readContract({address:callerRouter,abi:ABI,functionName:'approvedAdapter',args:[adapter]}).catch(()=>false);
 const adapterInputBalance=await client.readContract({address:tokenIn,abi:ABI,functionName:'balanceOf',args:[adapter]});
 const routeData=encodeAbiParameters([{type:'address[]'},{type:'uint256'}],[normalizedPath,deadline]);
 const data=encodeFunctionData({abi:ABI,functionName:'swapExactInput',args:[tokenIn,tokenOut,amountIn,minOut,recipient,routeData]});
 // eth_call uses the real callerRouter address as msg.sender. It does not sign or broadcast.
 try{
  const result=await client.call({account:callerRouter,to:adapter,data,gas:5_000_000n});
  return NextResponse.json({compatible:true,approved,simulated:true,callerRouter,dexRouter,adapterInputBalance:adapterInputBalance.toString(),resultData:result.data,warning:'eth_call success is conditional on current state and adapter funding. It does not guarantee later execution, tax compatibility, or protection from price changes.'});
 }catch(e){return NextResponse.json({compatible:true,approved,simulated:false,callerRouter,dexRouter,adapterInputBalance:adapterInputBalance.toString(),reason:e instanceof Error ? ('shortMessage' in e && typeof e.shortMessage === 'string' ? e.shortMessage : e.message) : 'Simulation reverted',warning:'An unfunded adapter normally reverts. This is not a funded Base-fork simulation and does not establish route incompatibility.'});}
}catch(e){return bad(e instanceof Error?e.message:'Simulation unavailable',502);}}
