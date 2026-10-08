import {NextRequest,NextResponse} from 'next/server';
import {createPublicClient,http,isAddress,getAddress,parseAbi} from 'viem';
import {base} from 'viem/chains';
export const runtime='nodejs';export const dynamic='force-dynamic';
const abi=parseAbi(['function dexRouter() view returns(address)','function callerRouter() view returns(address)','function factory() view returns(address)','function getPair(address,address) view returns(address)','function getReserves() view returns(uint112,uint112,uint32)','function token0() view returns(address)','function decimals() view returns(uint8)','function approvedAdapter(address) view returns(bool)','function inspectPath(address,address,address[],uint256) view returns(bool)']);
const ZERO='0x0000000000000000000000000000000000000000';
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH='0x4200000000000000000000000000000000000006';
const MAX_AMOUNT=10n**60n;
const rpc=process.env.BASE_RPC_URL||process.env.NEXT_PUBLIC_BASE_RPC_URL||'https://mainnet.base.org';
type Address = `0x${string}`;
const addr=(x:unknown):Address|null=>typeof x==='string'&&isAddress(x)?getAddress(x):null;
const fail=(message:string,status=400)=>NextResponse.json({error:message},{status});
export async function POST(req:NextRequest){try{
 const body=await req.json();const adapter=addr(body.adapter),tokenIn=addr(body.tokenIn),tokenOut=addr(body.tokenOut);
 if(!adapter||!tokenIn||!tokenOut||tokenIn===tokenOut)return fail('Valid adapter and distinct token addresses required');
 if(typeof body.amountIn!=='string'||!/^\d+$/.test(body.amountIn))return fail('amountIn must be an integer in token base units');
 const amountIn=BigInt(body.amountIn);if(amountIn<=0n||amountIn>MAX_AMOUNT)return fail('Invalid amount');
 const client=createPublicClient({chain:base,transport:http(rpc,{timeout:12000})});
 if(!await client.getCode({address:adapter}))return fail('Adapter is not deployed on Base');
 const dexRouter=await client.readContract({address:adapter,abi,functionName:'dexRouter'});
 const callerRouter=await client.readContract({address:adapter,abi,functionName:'callerRouter'});
 if(!await client.getCode({address:dexRouter}))return fail('Adapter router has no code');
 const factory=await client.readContract({address:dexRouter,abi,functionName:'factory'});
 const authorized=await client.readContract({address:callerRouter,abi,functionName:'approvedAdapter',args:[adapter]}).catch(()=>false);
 if(!await client.getCode({address:factory}))return fail('DEX factory has no code');
 const extras:Address[]=Array.isArray(body.intermediates)?(body.intermediates as unknown[]).slice(0,4).map(addr).filter((a:Address|null):a is Address=>a!==null):[];
 const mids:Address[]=[USDC,WETH,...extras].map((x:string):Address=>getAddress(x)).filter((x:Address,i:number,a:Address[])=>x!==tokenIn&&x!==tokenOut&&a.indexOf(x)===i);
 const candidates:Address[][]=[[tokenIn,tokenOut],...mids.map((m:Address):Address[]=>[tokenIn,m,tokenOut]),...mids.flatMap((a:Address,i:number)=>mids.filter((_b:Address,j:number)=>i!==j).map((b:Address):Address[]=>[tokenIn,a,b,tokenOut]))];
 const deadline=BigInt(Math.floor(Date.now()/1000)+600);
 const pairCache=new Map<string,{pair:`0x${string}`,reserve0:bigint,reserve1:bigint,token0:`0x${string}`}|null>();
 async function pairFor(a:`0x${string}`,b:`0x${string}`){const key=[a.toLowerCase(),b.toLowerCase()].sort().join(':');if(pairCache.has(key))return pairCache.get(key)!;
 try{const pair=await client.readContract({address:factory,abi,functionName:'getPair',args:[a,b]});if(pair===ZERO||!await client.getCode({address:pair})){pairCache.set(key,null);return null;}
 const [res,token0]=await Promise.all([client.readContract({address:pair,abi,functionName:'getReserves'}),client.readContract({address:pair,abi,functionName:'token0'})]);const data={pair,reserve0:res[0],reserve1:res[1],token0};pairCache.set(key,data);return data;
 }catch{pairCache.set(key,null);return null;}}
 const results=[] as {path:string[],pairs:string[],indicativeOut:string,hops:number,compatible:boolean}[];
 for(const path of candidates){let value=amountIn;const pairs:string[]=[];let good=true;
 for(let i=0;i<path.length-1;i++){const a=getAddress(path[i]),b=getAddress(path[i+1]);const p=await pairFor(a,b);if(!p){good=false;break;}
 const [reserveIn,reserveOut]=a.toLowerCase()===p.token0.toLowerCase()?[p.reserve0,p.reserve1]:[p.reserve1,p.reserve0];if(reserveIn<=0n||reserveOut<=0n){good=false;break;}
 // Indicative Uniswap V2 0.30% model. Not valid for other fee tiers or taxed tokens.
 const afterFee=value*997n;value=afterFee*reserveOut/(reserveIn*1000n+afterFee);if(value===0n){good=false;break;}pairs.push(p.pair);
 }
 if(!good)continue;
 const compatible=await client.readContract({address:adapter,abi,functionName:'inspectPath',args:[tokenIn,tokenOut,path.map(x=>getAddress(x)),deadline]});
 results.push({path,pairs,indicativeOut:value.toString(),hops:path.length-1,compatible});
 }
 results.sort((a,b)=>BigInt(a.indicativeOut)===BigInt(b.indicativeOut)?a.hops-b.hops:BigInt(a.indicativeOut)>BigInt(b.indicativeOut)?-1:1);
 return NextResponse.json({chainId:8453,adapter,dexRouter,factory,callerRouter,authorized,amountIn:amountIn.toString(),routes:results.slice(0,12),deadline:deadline.toString(),model:'Uniswap V2 0.30% fee, no transfer taxes',executionReady:false,warning:'Discovery only. Reserve estimates do NOT account for variable DEX fees, fee-on-transfer tokens, MEV or price movement. Do not derive minimum output or tax limits from these estimates. Execute only after independent simulation and user-confirmed limits.'});
 }catch(e){return fail(e instanceof Error?e.message:'Discovery failed',502);}}
