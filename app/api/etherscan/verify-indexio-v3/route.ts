import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { indexioV3StandardJsonInput } from '../../../../lib/indexio-v3-verification.generated';

export const runtime = 'nodejs';

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const BASE_CHAIN_ID = '8453';
const BASE_RPC = process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org';
const COMPILER = 'v0.8.30+commit.73712a01';
const CONTRACTS = {
  governanceConfig: { fq: 'contracts/indexio-v3/IndexioGovernanceConfigV3.sol:IndexioGovernanceConfigV3' },
  safetyController: { fq: 'contracts/indexio-v3/IndexioSafetyControllerV3.sol:IndexioSafetyControllerV3' },
  transferPolicy: { fq: 'contracts/indexio-v3/IndexioTransferPolicyV3.sol:IndexioTransferPolicyV3' },
  factory: { fq: 'contracts/indexio-v3/IndexioFactoryV3.sol:IndexioFactoryV3' },
  vaultDeployer: { fq: 'contracts/indexio-v3/IndexioVaultDeployerV3.sol:IndexioVaultDeployerV3' },
  executionRouter: { fq: 'contracts/indexio-v3/IndexioExecutionRouterV3.sol:IndexioExecutionRouterV3' },
  restrictedSwapAdapter: { fq: 'contracts/indexio-v3/IndexioRestrictedSwapAdapterV3.sol:IndexioRestrictedSwapAdapterV3' },
  lifiSwapAdapter: { fq: 'contracts/indexio-v3/IndexioLifiSwapAdapterV3.sol:IndexioLifiSwapAdapterV3' },
} as const;
type ContractKind = keyof typeof CONTRACTS;

async function readJson(res: Response) { const text = await res.text(); try { return JSON.parse(text); } catch { return { message: text || res.statusText, __nonJson: true }; } }
function clean(value: unknown, fallback: string) { const s=String(value||'').trim(); if(!s || /<(?:!doctype|html|head|body)/i.test(s)) return fallback; return s.length>500?`${s.slice(0,500)}…`:s; }
async function hasCodeOnBase(address:string){ try{const r=await fetch(BASE_RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getCode',params:[address,'latest']}),cache:'no-store'});const j=await readJson(r);const code=String(j?.result||'');return r.ok&&/^0x[0-9a-fA-F]+$/.test(code)&&code!=='0x'&&code!=='0x0';}catch{return false;} }
function apiKey(){return process.env.ETHERSCAN_API_KEY||'';}
async function etherscan(params:Record<string,string>){const url=new URL(ETHERSCAN_V2);url.searchParams.set('chainid',BASE_CHAIN_ID);url.searchParams.set('apikey',apiKey());const p=new URLSearchParams(params);const r=await fetch(url.toString(),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:p.toString(),cache:'no-store'});return {res:r,body:await readJson(r)};}
async function alreadyVerified(address:string){const {res,body}=await etherscan({module:'contract',action:'getsourcecode',address});if(!res.ok||body?.__nonJson||String(body?.status)!=='1')return false;const item=Array.isArray(body?.result)?body.result[0]:null;return Boolean(item&&String(item.SourceCode||'').trim());}
async function checkGuid(guid:string){const {res,body}=await etherscan({module:'contract',action:'checkverifystatus',guid});const result=clean(body?.result||body?.message,'Etherscan verification status is temporarily unavailable.');const verified=/pass|verified/i.test(result)&&!/pending/i.test(result);const pending=/pending|queue|in progress/i.test(result);return {ok:res.ok&&!body?.__nonJson,verified,pending,message:result};}

export async function POST(req:NextRequest){
 try{
  const {kind,address,constructorArguments='',mode='verify',guid=''}=await req.json();
  if(!(kind in CONTRACTS)||!isAddress(address))return NextResponse.json({error:'Valid V3 contract kind/address required.'},{status:400});
  if(!apiKey())return NextResponse.json({error:'ETHERSCAN_API_KEY is not configured on the server. The Base deployment remains valid and you can continue deployment.'},{status:503});
  if(!await hasCodeOnBase(address))return NextResponse.json({error:'No contract bytecode is visible at this address on Base. Check the recorded address before continuing.',deployed:false},{status:409});
  if(await alreadyVerified(address))return NextResponse.json({ok:true,deployed:true,verified:true,message:'Source verified on Etherscan/BaseScan.'});
  if(mode==='check'){
   if(guid){const s=await checkGuid(String(guid));return NextResponse.json({ok:true,deployed:true,verified:s.verified,pending:s.pending,guid,message:s.message});}
   return NextResponse.json({ok:true,deployed:true,verified:false,pending:false,message:'Contract is deployed on Base but is not source-verified yet. Tap Verify source with Etherscan to submit it.'});
  }
  const contract=CONTRACTS[kind as ContractKind];
  const {res,body}=await etherscan({module:'contract',action:'verifysourcecode',contractaddress:address,sourceCode:indexioV3StandardJsonInput,codeformat:'solidity-standard-json-input',contractname:contract.fq,compilerversion:COMPILER,constructorArguments:String(constructorArguments).replace(/^0x/,'')});
  const result=clean(body?.result||body?.message,'Etherscan returned an unreadable verification response.');
  if(/already verified/i.test(result))return NextResponse.json({ok:true,deployed:true,verified:true,message:'Source already verified on Etherscan/BaseScan.'});
  if(!res.ok||body?.__nonJson||String(body?.status)!=='1')return NextResponse.json({error:`Contract is deployed on Base, but Etherscan did not accept source verification: ${result}`,deployed:true},{status:422});
  const newGuid=String(body.result||'').trim();
  if(!newGuid)return NextResponse.json({error:'Etherscan accepted the request but did not return a verification GUID. The deployment remains valid.',deployed:true},{status:422});
  for(let i=0;i<5;i++){await new Promise(r=>setTimeout(r,1200));const s=await checkGuid(newGuid);if(s.verified)return NextResponse.json({ok:true,deployed:true,verified:true,guid:newGuid,message:'Source verified on Etherscan/BaseScan.'});if(!s.pending&&/fail|unable|error/i.test(s.message))return NextResponse.json({error:`Etherscan verification failed: ${s.message}`,deployed:true,guid:newGuid},{status:422});}
  return NextResponse.json({ok:true,deployed:true,verified:false,pending:true,guid:newGuid,message:'Verification submitted to Etherscan and is processing. You can continue deploying; source verification does not block the next step.'});
 }catch(e){return NextResponse.json({error:clean(e instanceof Error?e.message:'','Etherscan verification failed. The recorded Base deployment is unchanged.')},{status:500});}
}
