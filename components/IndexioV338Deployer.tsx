'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { base } from 'viem/chains';
import { decodeEventLog, getAddress, isAddress, parseAbi, type Address, type Hex } from 'viem';
import {
  indexioV338SafetyControllerAbi,indexioV338SafetyControllerBytecode,
  indexioV338TransferPolicyAbi,indexioV338TransferPolicyBytecode,
  indexioV338CodeBlobAbi,indexioV338CodeBlobBytecode,
  indexioV338VaultDeployerAbi,indexioV338VaultDeployerBytecode,
  indexioV338FactoryAbi,indexioV338FactoryBytecode,
  indexioV338ExecutionRouterAbi,indexioV338ExecutionRouterBytecode,
  indexioV338RestrictedSwapAdapterAbi,indexioV338RestrictedSwapAdapterBytecode,
  indexioV338LifiSwapAdapterAbi,indexioV338LifiSwapAdapterBytecode,
  indexioV338VaultBytecode,indexioV338VaultCreationCodeHash,indexioV338VaultCreationCodeLength,
} from '../lib/indexio-v338.generated';

const REGISTRY=getAddress('0x5C4791e3B752d9b084E8FD76932E82C2031f15c1');
const USDC=getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const EXPLORER='https://basescan.org';
const KEY='indexio-v338-base-suite';
const MAX_CHUNK_BYTES=23_500;
const FACTORY_READ=parseAbi(['function validateComposition(address[] assets,uint16[] weights)','function isVault(address) view returns (bool)']);
const DEPLOY_EVENT_ABI=[{type:'event',name:'VaultDeployed',anonymous:false,inputs:[{indexed:true,name:'factory',type:'address'},{indexed:true,name:'creator',type:'address'},{indexed:true,name:'vault',type:'address'},{indexed:false,name:'shareToken',type:'address'},{indexed:false,name:'incomeHub',type:'address'},{indexed:false,name:'governor',type:'address'},{indexed:false,name:'distributionBps',type:'uint16'},{indexed:false,name:'initialSharePriceUsd18',type:'uint256'}]}] as const;
type Suite={owner:string;treasury:string;addresses:Record<string,Address>;bindings:Record<string,boolean>};
const emptySuite:Suite={owner:'',treasury:'',addresses:{},bindings:{}};
const short=(x:string)=>x?`${x.slice(0,7)}…${x.slice(-5)}`:'Not set';

export function IndexioV338Deployer(){
 const {address,isConnected,chainId}=useAccount();
 const {connectAsync,connectors}=useConnect();
 const {switchChainAsync}=useSwitchChain();
 const pc=usePublicClient({chainId:base.id});
 const {data:wc}=useWalletClient({chainId:base.id});
 const [suite,setSuite]=useState<Suite>(emptySuite);
 const [ready,setReady]=useState(false);
 const [busy,setBusy]=useState('');
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [tab,setTab]=useState<'suite'|'create'>('suite');
 const [name,setName]=useState('');
 const [symbol,setSymbol]=useState('');
 const [assetRows,setAssetRows]=useState([{asset:'',weight:'10000'}]);
 const [creatorFee,setCreatorFee]=useState('0');
 const [reward,setReward]=useState('0');
 const [distribution,setDistribution]=useState('0');
 const [vault,setVault]=useState('');

 useEffect(()=>{try{const raw=localStorage.getItem(KEY);if(raw){const saved=JSON.parse(raw);setSuite({...emptySuite,...saved,addresses:saved.addresses||{},bindings:saved.bindings||{}})}}catch{}finally{setReady(true)}},[]);
 useEffect(()=>{if(ready){try{localStorage.setItem(KEY,JSON.stringify(suite))}catch{}}},[ready,suite]);
 useEffect(()=>{if(address){setSuite(s=>({...s,owner:s.owner||address,treasury:s.treasury||address}))}},[address]);
 const owner=useMemo(()=>isAddress(suite.owner)?getAddress(suite.owner):null,[suite.owner]);
 const treasury=useMemo(()=>isAddress(suite.treasury)?getAddress(suite.treasury):null,[suite.treasury]);
 const codeParts=useMemo(()=>{const h=indexioV338VaultBytecode.slice(2);const bytes=h.length/2;const splitAt=Math.ceil(bytes/2)*2;return [`0x${h.slice(0,splitAt)}`,`0x${h.slice(splitAt)}`] as Hex[]},[]);
 const baseReady=isConnected&&chainId===base.id&&!!wc&&!!pc;

 async function ensureBase(){if(!isConnected){if(!connectors[0])throw Error('No injected wallet found. Install or open MetaMask, then reconnect.');await connectAsync({connector:connectors[0]});return false;}if(chainId!==base.id){await switchChainAsync({chainId:base.id});return false;}if(!wc||!pc)throw Error('Wallet connection is still initializing. Try again.');return true;}
 async function deployContract(key:string,label:string,abi:any,bytecode:Hex,args:any[]):Promise<Address|null>{
   if(!await ensureBase())return null;
   if(!owner)throw Error('Enter a valid protocol owner address first.');
   setBusy(key);setError('');setNotice('');
   try{const hash=await (wc!.deployContract as any)({abi,bytecode,args,account:wc!.account});const receipt=await pc!.waitForTransactionReceipt({hash});if(receipt.status!=='success'||!receipt.contractAddress)throw Error(`${label} deployment reverted.`);const deployed=getAddress(receipt.contractAddress);setSuite(s=>({...s,addresses:{...s.addresses,[key]:deployed}}));setNotice(`${label} deployed and confirmed on Base.`);return deployed}catch(e:any){setError(e?.shortMessage||e?.message||String(e));return null}finally{setBusy('')}
 }
 async function write(key:string,label:string,to:Address,abi:any,functionName:string,args:any[]){
   if(!await ensureBase())return;
   setBusy(key);setError('');setNotice('');
   try{const hash=await (wc!.writeContract as any)({address:to,abi,functionName,args,account:wc!.account});const receipt=await pc!.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw Error(`${label} transaction reverted.`);setSuite(s=>({...s,bindings:{...s.bindings,[key]:true}}));setNotice(`${label} confirmed on Base.`)}catch(e:any){setError(e?.shortMessage||e?.message||String(e))}finally{setBusy('')}
 }
 async function deployCodeBlob(index:number){
   if(!await ensureBase())return;
   const chunk=codeParts[index];if(!chunk)throw Error('Vault code segment is missing.');
   const key=`codeBlob${index?'B':'A'}`;
   const deployed=await deployContract(key,`Vault bytecode segment ${index+1}`,indexioV338CodeBlobAbi,indexioV338CodeBlobBytecode,[chunk]);
   if(!deployed||!pc)return;const runtime=await pc.getBytecode({address:deployed});if(runtime?.toLowerCase()!==`0x00${chunk.slice(2)}`.toLowerCase()){setError(`Stored code segment ${index+1} did not match the generated vault artifact.`);setSuite(s=>{const addresses={...s.addresses};delete addresses[key];return {...s,addresses}})}else setNotice(`Vault bytecode segment ${index+1} is deployed and verified.`)
 }
 async function deployVaultDeployer(){
   if(!suite.addresses.codeBlobA||!suite.addresses.codeBlobB) return setError('Deploy both immutable vault bytecode segments first.');
   await deployContract('vaultDeployer','Compact-call Vault Deployer',indexioV338VaultDeployerAbi,indexioV338VaultDeployerBytecode,[owner,indexioV338VaultCreationCodeHash,indexioV338VaultCreationCodeLength,suite.addresses.codeBlobA,Math.ceil(codeParts[0].slice(2).length/2),suite.addresses.codeBlobB,Math.ceil(codeParts[1].slice(2).length/2)]);
 }
 async function deployFactory(){if(!suite.addresses.safety||!suite.addresses.transferPolicy||!suite.addresses.vaultDeployer||!treasury)return setError('Set owner and treasury, then deploy Safety, Transfer Policy and Vault Deployer first.');await deployContract('factory','Indexio V3.3.8 Factory',indexioV338FactoryAbi,indexioV338FactoryBytecode,[owner,REGISTRY,USDC,treasury,suite.addresses.safety,suite.addresses.vaultDeployer,suite.addresses.transferPolicy]);}
 async function deployRouter(){if(!suite.addresses.factory)return setError('Deploy the Factory first.');await deployContract('executionRouter','Execution Router',indexioV338ExecutionRouterAbi,indexioV338ExecutionRouterBytecode,[owner,suite.addresses.factory]);}
 async function deployAdapter(key:string){if(!suite.addresses.executionRouter)return setError('Deploy the Execution Router first.');if(key==='zeroXAdapter')await deployContract(key,'0x Restricted Adapter',indexioV338RestrictedSwapAdapterAbi,indexioV338RestrictedSwapAdapterBytecode,[suite.addresses.executionRouter]);else await deployContract(key,'LI.FI Restricted Adapter',indexioV338LifiSwapAdapterAbi,indexioV338LifiSwapAdapterBytecode,[owner,suite.addresses.executionRouter]);}
 async function createIndex(){
   if(!await ensureBase())return;
   setBusy('create');setError('');setNotice('');
   try{
     if(!suite.addresses.factory||!suite.addresses.vaultDeployer||!suite.bindings.factoryRouter)throw Error('Finish and confirm the suite wiring before creating an index.');
     if(!name.trim()||!symbol.trim())throw Error('Add an index name and share symbol.');
     if(assetRows.some(x=>!isAddress(x.asset)))throw Error('Enter a valid Base token address for every asset.');
     const assets=assetRows.map(x=>getAddress(x.asset));const weights=assetRows.map(x=>Number(x.weight));
     if(assets.length===0||assets.length>20||new Set(assets.map(x=>x.toLowerCase())).size!==assets.length)throw Error('Use 1–20 unique assets.');
     if(weights.some(x=>!Number.isInteger(x)||x<1||x>10000)||weights.reduce((a,b)=>a+b,0)!==10000)throw Error('Weights must be whole basis points totaling 10,000.');
     const cfee=Number(creatorFee),rew=Number(reward),dist=Number(distribution);if(!Number.isInteger(cfee)||cfee<0||cfee>100||!Number.isInteger(rew)||rew<0||rew>2000||!Number.isInteger(dist)||dist<0||dist>10000)throw Error('Creator fee: 0–100 bps; reward: 0–2,000 bps; payout: 0–10,000 bps.');
     await (pc!.readContract as any)({address:suite.addresses.factory,abi:FACTORY_READ,functionName:'validateComposition',args:[assets,weights]});
     const hash=await (wc!.writeContract as any)({address:suite.addresses.vaultDeployer,abi:indexioV338VaultDeployerAbi,functionName:'deploy',args:[name.trim(),symbol.trim(),assets,weights,cfee,rew,dist,1000000000000000000n],account:wc!.account});
     setNotice('Vault submitted. Waiting for Base confirmation…');const receipt=await pc!.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw Error('Vault creation transaction reverted.');
     let found='';for(const log of receipt.logs){try{const event=decodeEventLog({abi:DEPLOY_EVENT_ABI,data:log.data,topics:log.topics});if(event.eventName==='VaultDeployed'){found=String(event.args.vault);break}}catch{}}
     if(!found)throw Error('Transaction confirmed, but the VaultDeployed event could not be decoded. Check the transaction on BaseScan before retrying.');
     const deployed=getAddress(found);setVault(deployed);setTab('create');setNotice('Index created. Continue to the 25 USDC seed step.');
   }catch(e:any){setError(e?.shortMessage||e?.message||String(e))}finally{setBusy('')}
 }
 function addAsset(){setAssetRows(r=>[...r,{asset:'',weight:''}])}
 function updateRow(i:number,key:'asset'|'weight',value:string){setAssetRows(r=>r.map((x,j)=>j===i?{...x,[key]:value}:x))}
 const rows=[
  ['safety','1 · Emergency Safety Controller',()=>deployContract('safety','Emergency Safety Controller',indexioV338SafetyControllerAbi,indexioV338SafetyControllerBytecode,[owner]),!!suite.addresses.safety],
  ['transferPolicy','2 · Transfer-Tax Policy',()=>deployContract('transferPolicy','Transfer-Tax Policy',indexioV338TransferPolicyAbi,indexioV338TransferPolicyBytecode,[owner]),!!suite.addresses.transferPolicy],
  ['code','3 · Store vault creation code once',async()=>{if(!suite.addresses.codeBlobA)await deployCodeBlob(0);else if(!suite.addresses.codeBlobB)await deployCodeBlob(1)},!!suite.addresses.codeBlobA&&!!suite.addresses.codeBlobB],
  ['vaultDeployer','4 · Compact-call Vault Deployer',deployVaultDeployer,!!suite.addresses.vaultDeployer],
  ['factory','5 · Indexio V3.3.8 Factory',deployFactory,!!suite.addresses.factory],
  ['safetyBind','6 · Bind Safety to Factory',()=>write('safetyBind','Safety → Factory',suite.addresses.safety,indexioV338SafetyControllerAbi,'setFactoryOnce',[suite.addresses.factory]),!!suite.bindings.safety],
  ['deployerBind','7 · Bind Vault Deployer to Factory',()=>write('deployerBind','Vault Deployer → Factory',suite.addresses.vaultDeployer,indexioV338VaultDeployerAbi,'setFactoryOnce',[suite.addresses.factory]),!!suite.bindings.deployer],
  ['executionRouter','8 · Execution Router',deployRouter,!!suite.addresses.executionRouter],
  ['zeroXAdapter','9 · 0x Restricted Adapter',()=>deployAdapter('zeroXAdapter'),!!suite.addresses.zeroXAdapter],
  ['lifiAdapter','10 · LI.FI Restricted Adapter',()=>deployAdapter('lifiAdapter'),!!suite.addresses.lifiAdapter],
  ['wireZeroX','11 · Approve 0x adapter',()=>write('wireZeroX','0x adapter approval',suite.addresses.executionRouter,indexioV338ExecutionRouterAbi,'setAdapter',[suite.addresses.zeroXAdapter,true]),!!suite.bindings.zeroX],
  ['wireLifi','12 · Approve LI.FI adapter',()=>write('wireLifi','LI.FI adapter approval',suite.addresses.executionRouter,indexioV338ExecutionRouterAbi,'setAdapter',[suite.addresses.lifiAdapter,true]),!!suite.bindings.lifi],
  ['factoryRouter','13 · Lock Factory to Execution Router',()=>write('factoryRouter','Factory → Execution Router lock',suite.addresses.factory,indexioV338FactoryAbi,'setExecutionRouterOnce',[suite.addresses.executionRouter]),!!suite.bindings.factoryRouter],
 ];
 const url=(a:string)=>`${EXPLORER}/address/${a}`;

 return <main className="shell">
  <header className="hero"><div className="brandRow"><div className="mark">I</div><div><div className="eyebrow">INDEXIO · BASE MAINNET · V3.3.8</div><div className="networkPill"><i/>Compact vault creation</div></div></div><h1>Indexio contract suite</h1><p>Reuse the existing Asset Registry. Store the verified vault creation code once, then create every index with a small MetaMask request.</p></header>
  <section className="walletBox"><div><span>WALLET</span><b>{isConnected?short(address||''): 'Not connected'} · {chainId===base.id?'Base':'Switch to Base'}</b></div><button className="ghost compact" onClick={async()=>{try{if(!isConnected&&connectors[0])await connectAsync({connector:connectors[0]});else if(chainId!==base.id)await switchChainAsync({chainId:base.id})}catch(e:any){setError(e?.shortMessage||e?.message||String(e))}}}>{isConnected?(chainId===base.id?'Connected':'Switch network'):'Connect MetaMask'}</button></section>
  <div className="statusGrid"><article><span>ASSET REGISTRY</span><b>Reused</b><small>{short(REGISTRY)}</small></article><article><span>VAULT CODE</span><b>{indexioV338VaultCreationCodeLength.toLocaleString()} bytes</b><small>Stored across {codeParts.length} immutable segments</small></article></div>
  <nav className="tabs"><button className={tab==='suite'?'selected':'ghost'} onClick={()=>setTab('suite')}>Contract suite</button><button className={tab==='create'?'selected':'ghost'} onClick={()=>setTab('create')}>Create index</button></nav>
  {tab==='suite'?<>
   <section className="card"><div className="stepHead"><div className="stepNo">SETUP</div><div><h2>Deployment record</h2><p>Saved on this device as you go. Each deployment and wiring action is a separate wallet confirmation, so you can resume after a refresh.</p></div></div>
    <label className="field">Protocol owner<input value={suite.owner} onChange={e=>setSuite(s=>({...s,owner:e.target.value}))} placeholder="0x…"/></label><label className="field">Fee treasury<input value={suite.treasury} onChange={e=>setSuite(s=>({...s,treasury:e.target.value}))} placeholder="0x…"/></label><div className="notice">USDC is fixed to Base USDC. Registry is fixed to the existing Indexio Asset Registry. Verify both addresses before deploying.</div>
   </section>
   {rows.map(([key,label,action,done],i)=>{const blocked=(i>0&&!rows.slice(0,i).every(r=>r[3] as boolean))||!owner||!treasury;const isBlob=key==='code';return <section className="card" key={String(key)}><div className="stepHead"><div className="stepNo">{String(i+1).padStart(2,'0')}</div><div><h2>{label as string}</h2><p>{done?'Confirmed and recorded on this device.':isBlob?`Two small one-time storage deployments; each segment is at most ${MAX_CHUNK_BYTES.toLocaleString()} bytes.`:'Continue one confirmed Base transaction at a time.'}</p></div></div>{key==='factory'&&<div className="candidate">Factory uses the new Vault Deployer and the existing Asset Registry. It must be new because the current factory permanently points to the V3.3.7 deployer.</div>}{key==='code'&&<div className="details"><div><span>Segment A</span><code>{suite.addresses.codeBlobA||'Not deployed'}</code></div><div><span>Segment B</span><code>{suite.addresses.codeBlobB||'Not deployed'}</code></div></div>}{done&&suite.addresses[String(key)]&&<a className="linkButton" href={url(suite.addresses[String(key)])} target="_blank" rel="noreferrer">View on BaseScan ↗</a>}{!done&&<button className="primary deploy" disabled={blocked||!!busy||!baseReady} onClick={()=>{setError('');(action as ()=>Promise<void>)().catch((e:any)=>setError(e?.message||String(e)))}}>{busy===key?`Waiting for ${label as string}…`:busy?'Another transaction is pending':`Continue: ${label as string}`}</button>}</section>})}
  </>:<>
   {vault?<section className="card"><div className="stepHead"><div className="stepNo">DONE</div><div><h2>Your index is ready to seed</h2><p>The vault is confirmed on Base. The required seed is at least 25 USDC.</p></div></div><div className="contractBox"><span>VAULT ADDRESS</span><strong>{vault}</strong></div><a className="linkButton" href={`${EXPLORER}/address/${vault}`} target="_blank" rel="noreferrer">View vault on BaseScan ↗</a><a className="primary linkButton" href={`https://www.indexio.world/indexes/onchain/${vault}`} target="_blank" rel="noreferrer">Continue to 25 USDC seed ↗</a><button className="ghost" style={{marginTop:10}} onClick={()=>setVault('')}>Create another index</button></section>:<section className="card"><div className="stepHead"><div className="stepNo">NEW</div><div><h2>Create an index</h2><p>Configuration is checked against the on-chain Asset Registry before MetaMask is asked to confirm the compact deployer call.</p></div></div>
    <label className="field">Index name<input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Base Dividend Leaders"/></label><label className="field">Share symbol<input value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} placeholder="e.g. BDL" maxLength={12}/></label>
    {assetRows.map((x,i)=><div className="assetRow" key={i}><label className="field">Asset {i+1} contract<input value={x.asset} onChange={e=>updateRow(i,'asset',e.target.value)} placeholder="Base token address"/></label><label className="field">Weight (bps)<input value={x.weight} onChange={e=>updateRow(i,'weight',e.target.value)} inputMode="numeric" placeholder="e.g. 2500"/></label>{assetRows.length>1&&<button className="ghost compact remove" onClick={()=>setAssetRows(r=>r.filter((_,j)=>j!==i))}>Remove</button>}</div>)}
    {assetRows.length<20&&<button className="ghost" style={{marginTop:10}} onClick={addAsset}>Add another asset</button>}
    <div className="formGrid"><label className="field">Creator fee (bps, max 100)<input value={creatorFee} onChange={e=>setCreatorFee(e.target.value)} inputMode="numeric"/></label><label className="field">Income reward (bps, max 2,000)<input value={reward} onChange={e=>setReward(e.target.value)} inputMode="numeric"/></label><label className="field">Payout share (bps)<input value={distribution} onChange={e=>setDistribution(e.target.value)} inputMode="numeric"/></label></div>
    <div className="details"><div><span>Weight total</span><strong>{assetRows.reduce((a,x)=>a+(Number(x.weight)||0),0).toLocaleString()} / 10,000 bps</strong></div><div><span>Wallet calldata</span><strong>Constructor bytecode stays on-chain</strong></div></div>
    <button className="primary deploy" style={{marginTop:14}} disabled={!baseReady||!!busy||assetRows.reduce((a,x)=>a+(Number(x.weight)||0),0)!==10000} onClick={createIndex}>{busy==='create'?'Validating and creating…':'Validate configuration and create index'}</button>
   </section>}
  </>}
  {notice&&<div role="status" className="notice success">{notice}</div>}{error&&<div role="alert" className="notice danger">{error}</div>}
  <footer>Before deployment, independently verify the V3.3.8 source and the reused registry address. The code segments are immutable and checked against the compiled vault creation-code hash. Vault creation still costs network gas; this change keeps the large bytecode out of each user's MetaMask request.</footer>
 </main>
}
