import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { indexioV25StandardJsonInput } from '../../../../lib/indexio-v25-verification.generated';
export const runtime='nodejs';
const CHAIN_ID=8453, COMPILER='v0.8.30+commit.73712a01';
const CONTRACTS={
 vaultDeployer:'contracts/indexio-v25/IndexioVaultDeployerV25.sol:IndexioVaultDeployerV25',
 factory:'contracts/indexio-v25/IndexioFactoryV25.sol:IndexioFactoryV25',
 executionRouter:'contracts/indexio-v25/IndexioExecutionRouterV25.sol:IndexioExecutionRouterV25',
 rebalanceRouter:'contracts/indexio-v25/IndexioRebalanceRouterV25.sol:IndexioRebalanceRouterV25',
 reinvestmentRouter:'contracts/indexio-v25/IndexioReinvestmentRouterV25.sol:IndexioReinvestmentRouterV25',
 adapter:'contracts/indexio-v25/IndexioRestrictedSwapAdapterV25.sol:IndexioRestrictedSwapAdapterV25',
} as const;
async function json(res:Response){const t=await res.text();try{return JSON.parse(t)}catch{return {message:t}}}
async function verified(address:string,key:string){const r=await fetch(`https://base.blockscout.com/api/v2/smart-contracts/${address}`,{headers:key?{authorization:`Bearer ${key}`}:{},cache:'no-store'});if(!r.ok)return false;const j=await json(r);return j?.is_verified===true||j?.isVerified===true||String(j?.source_code||'').length>0;}
export async function POST(req:NextRequest){try{const key=process.env.BLOCKSCOUT_API_KEY||'';const {kind,address,constructorArguments='',mode='verify'}=await req.json();if(!(kind in CONTRACTS)||!isAddress(address))return NextResponse.json({error:'Valid V2.5 contract kind and address required.'},{status:400});if(await verified(address,key))return NextResponse.json({ok:true,verified:true,message:'Verified on Base Blockscout.'});if(mode==='check')return NextResponse.json({ok:true,verified:false,message:'Source not published yet.'});const body=new URLSearchParams({chain_id:String(CHAIN_ID),module:'contract',action:'verifysourcecode',codeformat:'solidity-standard-json-input',contractaddress:address,contractname:CONTRACTS[kind as keyof typeof CONTRACTS],compilerversion:COMPILER,sourceCode:indexioV25StandardJsonInput,constructorArguments:String(constructorArguments).replace(/^0x/,''),apikey:key});const r=await fetch('https://api.blockscout.com/v2/api',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...(key?{authorization:`Bearer ${key}`}:{})},body:body.toString(),cache:'no-store'});const j=await json(r);if(!r.ok||String(j?.status)==='0')return NextResponse.json({error:j?.result||j?.message||'Verification rejected',deployed:true},{status:422});for(let i=0;i<8;i++){await new Promise(x=>setTimeout(x,2000));if(await verified(address,key))return NextResponse.json({ok:true,verified:true,message:'Verified and published on Base Blockscout.'});}return NextResponse.json({ok:true,verified:false,message:'Verification accepted; publication pending. Do not redeploy.'});}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Verification failed.'},{status:500})}}
