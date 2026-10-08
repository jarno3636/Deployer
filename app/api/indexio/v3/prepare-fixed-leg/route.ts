import {NextRequest,NextResponse} from 'next/server';
import {createPublicClient,http,isAddress,getAddress,encodeAbiParameters,parseAbi} from 'viem';
import {base} from 'viem/chains';
export const runtime='nodejs';export const dynamic='force-dynamic';
const abi=parseAbi(['function callerRouter() view returns(address)','function inspectPath(address,address,address[],uint256) view returns(bool)','function approvedAdapter(address) view returns(bool)']);
const address=(v:unknown)=>typeof v==='string'&&isAddress(v)?getAddress(v):null;
const fail=(error:string,status=400)=>NextResponse.json({error},{status});
export async function POST(req:NextRequest){try{
 const b=await req.json();const adapter=address(b.adapter),tokenIn=address(b.tokenIn),tokenOut=address(b.tokenOut);
 const path=Array.isArray(b.path)?b.path.map(address):[];
 if(!adapter||!tokenIn||!tokenOut||path.length<2||path.length>4||path.some(x=>!x)||tokenIn===tokenOut)return fail('Invalid adapter or path');
 if(typeof b.amountIn!=='string'||typeof b.quotedOut!=='string'||typeof b.minOut!=='string'||![b.amountIn,b.quotedOut,b.minOut].every(v=>/^\d+$/.test(v)))return fail('Use raw integer amounts');
 const amountIn=BigInt(b.amountIn),quotedOut=BigInt(b.quotedOut),minOut=BigInt(b.minOut);
 if(amountIn<1n||quotedOut<1n||minOut<1n||amountIn>10n**60n||quotedOut>10n**60n||minOut>quotedOut)return fail('Invalid amount or minimum output');
 // Mirrors execution router maximum quote-to-minimum spread (5%). A quote is not independently verified here.
 if(minOut*10000n<quotedOut*9500n)return fail('Minimum output violates the execution router 5% maximum slippage rule');
 const client=createPublicClient({chain:base,transport:http(process.env.BASE_RPC_URL||'https://mainnet.base.org',{timeout:12000})});
 if(!await client.getCode({address:adapter}))return fail('Adapter not deployed');
 const callerRouter=await client.readContract({address:adapter,abi,functionName:'callerRouter'});
 const authorized=await client.readContract({address:callerRouter,abi,functionName:'approvedAdapter',args:[adapter]}).catch(()=>false);
 if(!authorized)return fail('One-time adapter authorization is missing; no per-route approval is needed',409);
 const deadline=BigInt(Math.floor(Date.now()/1000)+600);
 const normalized=path as `0x${string}`[];
 const compatible=await client.readContract({address:adapter,abi,functionName:'inspectPath',args:[tokenIn,tokenOut,normalized,deadline]});
 if(!compatible)return fail('Adapter rejected the route',409);
 const routeData=encodeAbiParameters([{type:'address[]'},{type:'uint256'}],[normalized,deadline]);
 return NextResponse.json({chainId:8453,adapter,callerRouter,tokenIn,tokenOut,deadline:deadline.toString(),leg:{adapter,amountIn:amountIn.toString(),quotedAmountOut:quotedOut.toString(),minAmountOut:minOut.toString(),routeData},status:'prepared-not-executed',warning:'This is a transaction leg, not an executable quote. quotedOut must come from a separately verified fresh quote; minOut must account for all taxes and slippage. Execute via the vault router only after complete multi-leg simulation and user confirmation.'});
 }catch(e){return fail(e instanceof Error?e.message:'Preparation failed',502);}}
