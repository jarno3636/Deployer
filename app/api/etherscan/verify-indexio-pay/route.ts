import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, encodeAbiParameters, fallback, getAddress, http, isAddress, isHex, type Hex } from 'viem';
import { base } from 'viem/chains';
import { indexioPayCreationBytecode, indexioPayCompiler, indexioPayStandardJsonInput } from '../../../../lib/indexio-pay-verification.generated';

export const runtime='nodejs';
const ETHERSCAN='https://api.etherscan.io/v2/api';
const FULL_NAME='contracts/IndexioPayRouter_V1.sol:IndexioPayRouter';
const client=createPublicClient({chain:base,transport:fallback([
 http(process.env.BASE_RPC_URL||'https://mainnet.base.org',{timeout:10_000,retryCount:1}),
 http('https://base-rpc.publicnode.com',{timeout:10_000,retryCount:1}),
])});
type ScanResult={status?:string;message?:string;result?:unknown};
const hits=new Map<string,{until:number;count:number}>();
function fail(message:string,status=400){return NextResponse.json({error:message},{status,headers:{'Cache-Control':'no-store'}})}
function response(body:object){return NextResponse.json(body,{headers:{'Cache-Control':'no-store'}})}
function message(value:unknown){return String(value??'Unexpected explorer response.').replace(/<[^>]+>/g,'').slice(0,400)}
function safeRequest(req:NextRequest){
 const origin=req.headers.get('origin');
 if(origin&&origin!==new URL(req.url).origin)return 'Request must come from this deployment app.';
 const key=(req.headers.get('x-forwarded-for')||'unknown').split(',')[0].trim().slice(0,80);
 const now=Date.now();const hit=hits.get(key);
 if(!hit||now>hit.until){hits.set(key,{until:now+60_000,count:1});return ''}
 if(hit.count>=24)return 'Too many verification requests. Retry after a minute.';
 hit.count++;return '';
}
async function scan(action:string,values:Record<string,string>={},method:'GET'|'POST'='GET'){
 const key=process.env.ETHERSCAN_API_KEY?.trim();
 if(!key)throw Error('ETHERSCAN_API_KEY is missing in Vercel. Add a server-side Etherscan V2 API key and redeploy the app.');
 const url=new URL(ETHERSCAN);
 url.searchParams.set('apikey',key);
 url.searchParams.set('chainid','8453');
 url.searchParams.set('module','contract');
 url.searchParams.set('action',action);
 const init:RequestInit={method,cache:'no-store',signal:AbortSignal.timeout(20_000)};
 if(method==='GET')for(const [k,v] of Object.entries(values))url.searchParams.set(k,v);
 else {init.headers={'Content-Type':'application/x-www-form-urlencoded'};init.body=new URLSearchParams(values).toString()}
 const res=await fetch(url,init);
 let data:ScanResult;
 try{data=await res.json()}catch{throw Error('Etherscan returned a non-JSON response. Try again later.')}
 if(!res.ok)throw Error(`Etherscan returned HTTP ${res.status}. Try again later.`);
 return data;
}
async function verified(address:string){
 const result=await scan('getsourcecode',{address});
 const item=Array.isArray(result.result)?result.result[0] as {SourceCode?:string}|undefined:undefined;
 return result.status==='1'&&Boolean(item?.SourceCode?.trim());
}
async function validateDeployment(address:string,transactionHash:string,treasury:string){
 const normalized=getAddress(address);
 const receipt=await client.getTransactionReceipt({hash:transactionHash as Hex});
 if(receipt.status!=='success'||!receipt.contractAddress||getAddress(receipt.contractAddress)!==normalized)
  throw Error('The transaction did not successfully deploy this contract address on Base.');
 const transaction=await client.getTransaction({hash:transactionHash as Hex});
 // Base also has deposit transactions, which have no chainId property in viem.
 // They are not normal wallet deployment transactions and must be rejected.
 if(transaction.type==='deposit')throw Error('A Base deposit transaction cannot deploy this Pay Router.');
 if(transaction.chainId!==base.id)throw Error('Deployment transaction was not sent on Base Mainnet.');
 if(transaction.to!==null)throw Error('This transaction is not a direct contract deployment.');
 const constructorArgs=encodeAbiParameters([{type:'address'}],[getAddress(treasury)]);
 const expected=(indexioPayCreationBytecode+constructorArgs.slice(2)).toLowerCase();
 if(transaction.input.toLowerCase()!==expected)
  throw Error('On-chain deployment bytecode or fee treasury does not match this Pay Router release. Verification was stopped.');
 const code=await client.getCode({address:normalized});
 if(!code||code==='0x')throw Error('The deployed contract has no code on Base.');
 return constructorArgs.slice(2);
}
export async function POST(req:NextRequest){
 const guard=safeRequest(req);if(guard)return fail(guard,429);
 try{
  const body=await req.json();
  const address=String(body?.address||'');
  const transactionHash=String(body?.transactionHash||'');
  const treasury=String(body?.treasury||'');
  const mode=String(body?.mode||'verify');
  const guid=String(body?.guid||'');
  if(!isAddress(address)||!isAddress(treasury)||!isHex(transactionHash,{strict:true})||transactionHash.length!==66)
   return fail('A valid Base contract address, deployment transaction hash, and fee treasury are required.');
  if(!['verify','check'].includes(mode))return fail('Unsupported verification action.');
  if(mode==='check'&&guid&&!/^[a-zA-Z0-9]{5,128}$/.test(guid))return fail('Invalid verification request ID.');
  // The server does not trust a user-supplied compiler, source, bytecode or
  // constructor argument. Require the exact on-chain deployment first.
  const constructorArguments=await validateDeployment(address,transactionHash,treasury);
  if(await verified(address))return response({ok:true,verified:true,pending:false,message:'Source verified on BaseScan.'});
  if(mode==='check'){
   if(!guid)return response({ok:true,verified:false,pending:false,message:'Deployed on Base; source verification has not completed.'});
   const checked=await scan('checkverifystatus',{guid});
   const status=message(checked.result||checked.message);
   if(/pass\s*-\s*verified|already verified/i.test(status))return response({ok:true,verified:true,pending:false,guid,message:'Source verified on BaseScan.'});
   if(/pending|queue|in progress/i.test(status))return response({ok:true,verified:false,pending:true,guid,message:'Verification is processing. You can check again without redeploying.'});
   return response({ok:true,verified:false,pending:false,guid,error:status,message:`Verification not completed: ${status}`});
  }
  const submit=await scan('verifysourcecode',{
   contractaddress:getAddress(address),sourceCode:indexioPayStandardJsonInput,
   contractname:FULL_NAME,compilerversion:indexioPayCompiler,
   codeformat:'solidity-standard-json-input',constructorArguments,
   licenseType:'3',optimizationUsed:'1',runs:'200',evmVersion:'cancun',
  },'POST');
  const result=message(submit.result||submit.message);
  if(/already verified/i.test(result))return response({ok:true,verified:true,pending:false,message:'Source already verified on BaseScan.'});
  if(submit.status!=='1')return fail(`BaseScan verification rejected the request: ${result}`,422);
  return response({ok:true,verified:false,pending:true,guid:result,message:'Source submitted for verification. Check the status to confirm publication.'});
 }catch(error){
  const reason=error instanceof Error?error.message:'Verification could not be completed.';
  const missing=/ETHERSCAN_API_KEY/.test(reason);
  return fail(message(reason),missing?503:422);
 }
}
