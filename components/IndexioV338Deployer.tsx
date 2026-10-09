'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { base } from 'viem/chains';
import { decodeEventLog, encodeAbiParameters, getAddress, isAddress, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem';
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
const RELEASE_ID=keccak256(stringToHex('INDEXIO_V3_3_6_HARDENED_RC'));
const FACTORY_READ=parseAbi(['function validateComposition(address[] assets,uint16[] weights)','function isVault(address) view returns (bool)']);
const DEPLOY_EVENT_ABI=[{type:'event',name:'VaultDeployed',anonymous:false,inputs:[{indexed:true,name:'factory',type:'address'},{indexed:true,name:'creator',type:'address'},{indexed:true,name:'vault',type:'address'},{indexed:false,name:'shareToken',type:'address'},{indexed:false,name:'incomeHub',type:'address'},{indexed:false,name:'governor',type:'address'},{indexed:false,name:'distributionBps',type:'uint16'},{indexed:false,name:'initialSharePriceUsd18',type:'uint256'}]}] as const;
type VerifyState='idle'|'pending'|'verified'|'error';
type Suite={owner:string;treasury:string;addresses:Record<string,Address>;bindings:Record<string,boolean>;verification:Record<string,VerifyState>;verificationGuids:Record<string,string>;transactions:Record<string,Hex>;deploymentBlocks:Record<string,string>;candidates:Record<string,Address>};
type VerifyTarget={key:string;label:string;kind:string;address?:Address;constructorArguments:Hex};
const emptySuite:Suite={owner:'',treasury:'',addresses:{},bindings:{},verification:{},verificationGuids:{},transactions:{},deploymentBlocks:{},candidates:{}};
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
 const [errorStep,setErrorStep]=useState('');
 const [notice,setNotice]=useState('');
 const [tab,setTab]=useState<'suite'|'create'>('suite');
 const [name,setName]=useState('');
 const [symbol,setSymbol]=useState('');
 const [assetRows,setAssetRows]=useState([{asset:'',weight:'10000'}]);
 const [creatorFee,setCreatorFee]=useState('0');
 const [reward,setReward]=useState('0');
 const [distribution,setDistribution]=useState('0');
 const [vault,setVault]=useState('');
 const [vaultConstructorArguments,setVaultConstructorArguments]=useState<Hex>('0x');
 const [vaultVerification,setVaultVerification]=useState<VerifyState>('idle');

 useEffect(()=>{try{const raw=localStorage.getItem(KEY);if(raw){const saved=JSON.parse(raw);const oldBindings=saved.bindings||{};setSuite({...emptySuite,...saved,addresses:saved.addresses||{},bindings:{...oldBindings,safety:Boolean(oldBindings.safety||oldBindings.safetyBind),deployer:Boolean(oldBindings.deployer||oldBindings.deployerBind),zeroX:Boolean(oldBindings.zeroX||oldBindings.wireZeroX),lifi:Boolean(oldBindings.lifi||oldBindings.wireLifi)},verification:saved.verification||{},verificationGuids:saved.verificationGuids||{},transactions:saved.transactions||{},deploymentBlocks:saved.deploymentBlocks||{},candidates:saved.candidates||{}})}}catch{}finally{setReady(true)}},[]);
 useEffect(()=>{if(ready){try{localStorage.setItem(KEY,JSON.stringify(suite))}catch{}}},[ready,suite]);
 useEffect(()=>{if(address){setSuite(s=>({...s,owner:s.owner||address,treasury:s.treasury||address}))}},[address]);
 const owner=useMemo(()=>isAddress(suite.owner)?getAddress(suite.owner):null,[suite.owner]);
 const treasury=useMemo(()=>isAddress(suite.treasury)?getAddress(suite.treasury):null,[suite.treasury]);
 const codeParts=useMemo(()=>{const h=indexioV338VaultBytecode.slice(2);const bytes=h.length/2;const splitAt=Math.ceil(bytes/2)*2;return [`0x${h.slice(0,splitAt)}`,`0x${h.slice(splitAt)}`] as Hex[]},[]);
 const baseReady=isConnected&&chainId===base.id&&!!wc&&!!pc;
 const blobLengths=useMemo(()=>codeParts.map(part=>(part.length-2)/2),[codeParts]);
 const verificationTargets=useMemo<VerifyTarget[]>(()=>{
  const a=suite.addresses;
  const encode=(params:any,values:any)=>encodeAbiParameters(params,values);
  const targets:VerifyTarget[]=[];
  if(owner&&a.safety)targets.push({key:'safety',label:'Emergency Safety Controller',kind:'safetyController',address:a.safety,constructorArguments:encode([{type:'address'}],[owner])});
  if(owner&&a.transferPolicy)targets.push({key:'transferPolicy',label:'Transfer-Tax Policy',kind:'transferPolicy',address:a.transferPolicy,constructorArguments:encode([{type:'address'}],[owner])});
  if(a.codeBlobA)targets.push({key:'codeBlobA',label:'Vault code segment A',kind:'codeBlob',address:a.codeBlobA,constructorArguments:encode([{type:'bytes'}],[codeParts[0]])});
  if(a.codeBlobB)targets.push({key:'codeBlobB',label:'Vault code segment B',kind:'codeBlob',address:a.codeBlobB,constructorArguments:encode([{type:'bytes'}],[codeParts[1]])});
  if(owner&&a.vaultDeployer&&a.codeBlobA&&a.codeBlobB)targets.push({key:'vaultDeployer',label:'Compact-call Vault Deployer',kind:'vaultDeployer',address:a.vaultDeployer,constructorArguments:encode([{type:'address'},{type:'bytes32'},{type:'uint32'},{type:'address'},{type:'uint32'},{type:'address'},{type:'uint32'}],[owner,indexioV338VaultCreationCodeHash,indexioV338VaultCreationCodeLength,a.codeBlobA,blobLengths[0],a.codeBlobB,blobLengths[1]])});
  if(owner&&treasury&&a.factory&&a.safety&&a.vaultDeployer&&a.transferPolicy)targets.push({key:'factory',label:'Indexio V3.3.8 Factory',kind:'factory',address:a.factory,constructorArguments:encode(Array(7).fill({type:'address'}),[owner,REGISTRY,USDC,treasury,a.safety,a.vaultDeployer,a.transferPolicy])});
  if(owner&&a.executionRouter&&a.factory)targets.push({key:'executionRouter',label:'Execution Router',kind:'executionRouter',address:a.executionRouter,constructorArguments:encode([{type:'address'},{type:'address'}],[owner,a.factory])});
  if(a.zeroXAdapter&&a.executionRouter)targets.push({key:'zeroXAdapter',label:'0x Restricted Adapter',kind:'restrictedSwapAdapter',address:a.zeroXAdapter,constructorArguments:encode([{type:'address'}],[a.executionRouter])});
  if(owner&&a.lifiAdapter&&a.executionRouter)targets.push({key:'lifiAdapter',label:'LI.FI Restricted Adapter',kind:'lifiSwapAdapter',address:a.lifiAdapter,constructorArguments:encode([{type:'address'},{type:'address'}],[owner,a.executionRouter])});
  return targets;
 },[suite.addresses,owner,treasury,codeParts,blobLengths]);
 const integrationData=useMemo(()=>({
  release:'INDEXIO_V3_3_8_COMPACT_DEPLOYMENT',uiVersion:'3.3.8',contractRelease:'3.3.6 Hardened RC',releaseId:RELEASE_ID,
  network:'Base Mainnet',chainId:8453,explorer:EXPLORER,
  protocolOwner:owner||suite.owner||null,feeTreasury:treasury||suite.treasury||null,
  assetRegistry:REGISTRY,settlementToken:USDC,
  safetyController:suite.addresses.safety||null,transferPolicy:suite.addresses.transferPolicy||null,
  vaultCode:{creationCodeHash:indexioV338VaultCreationCodeHash,creationCodeLength:indexioV338VaultCreationCodeLength,segmentA:suite.addresses.codeBlobA||null,segmentALength:blobLengths[0],segmentB:suite.addresses.codeBlobB||null,segmentBLength:blobLengths[1]},
  vaultDeployer:suite.addresses.vaultDeployer||null,factory:suite.addresses.factory||null,executionRouter:suite.addresses.executionRouter||null,
  adapters:{zeroX:suite.addresses.zeroXAdapter||null,lifi:suite.addresses.lifiAdapter||null},
  protocol:{protocolFeeBps:100,maxCreatorFeeBps:100,maxCreatorIncomeRewardBps:2000,minGrossSeedUsdc:'25',assetWeightTotalBps:10000,maxAssetsPerIndex:20},
  appCalls:{createVault:'deploy(string,string,address[],uint16[],uint16,uint16,uint16,uint256)',seedIndex:'seedIndex(address,uint256,(address,uint256,uint256,uint256,bytes)[],address,uint256)',factoryDiscovery:'vaultCount() / allVaults(uint256)',vaultCreatedEvent:'VaultDeployed(address,address,address,address,address,address,uint16,uint256)'},
  wiring:{safetyFactoryLocked:Boolean(suite.bindings.safety),vaultDeployerFactoryLocked:Boolean(suite.bindings.deployer),zeroXAdapterApproved:Boolean(suite.bindings.zeroX),lifiAdapterApproved:Boolean(suite.bindings.lifi),factoryRouterLocked:Boolean(suite.bindings.factoryRouter)},
  transactions:suite.transactions,deploymentBlocks:suite.deploymentBlocks,
  verification:Object.fromEntries(verificationTargets.map(x=>[x.key,{status:suite.verification[x.key]||'idle',baseScan:`${EXPLORER}/address/${x.address}#code`}]))
 }),[suite,owner,treasury,blobLengths,verificationTargets]);
 const deploymentRecord=useMemo(()=>`INDEXIO V3.3.8 — BASE MAINNET
Chain ID: 8453
Asset Registry: ${REGISTRY}
Base USDC: ${USDC}
Protocol Owner: ${owner||suite.owner||''}
Fee Treasury: ${treasury||suite.treasury||''}

Emergency Safety Controller: ${suite.addresses.safety||''}
Transfer-Tax Policy: ${suite.addresses.transferPolicy||''}
Vault Code Segment A: ${suite.addresses.codeBlobA||''}
Vault Code Segment B: ${suite.addresses.codeBlobB||''}
Vault Creation Code Hash: ${indexioV338VaultCreationCodeHash}
Vault Creation Code Length: ${indexioV338VaultCreationCodeLength}
Compact-call Vault Deployer: ${suite.addresses.vaultDeployer||''}
Factory: ${suite.addresses.factory||''}
Factory Deployment Block: ${suite.deploymentBlocks.factory||''}
Factory Deployment Transaction: ${suite.transactions.factory||''}
Execution Router: ${suite.addresses.executionRouter||''}
0x Restricted Adapter: ${suite.addresses.zeroXAdapter||''}
LI.FI Restricted Adapter: ${suite.addresses.lifiAdapter||''}
Router / Adapter Release ID: ${RELEASE_ID}

Minimum Seed: 25 USDC
Protocol Fee: 100 bps (1%)
Maximum Creator Fee: 100 bps (1%)
Factory Router Locked: ${suite.bindings.factoryRouter?'YES':'NO'}
Safety Factory Locked: ${suite.bindings.safety?'YES':'NO'}
Vault Deployer Factory Locked: ${suite.bindings.deployer?'YES':'NO'}
0x Adapter Approved: ${suite.bindings.zeroX?'YES':'NO'}
LI.FI Adapter Approved: ${suite.bindings.lifi?'YES':'NO'}
`,[suite,owner,treasury]);

 async function copyText(value:string,success:string){try{await navigator.clipboard.writeText(value);setNotice(success);setError('')}catch{setError('Clipboard access was blocked. Use a secure HTTPS page and allow clipboard access.')}}
 async function verifyTarget(target:VerifyTarget,quiet=false){
  setSuite(s=>({...s,verification:{...s.verification,[target.key]:'pending'}}));if(!quiet){setBusy(`verify:${target.key}`);setError('');setNotice('')}
  try{const current=suite.verification[target.key]||'idle';const guid=suite.verificationGuids[target.key]||'';const response=await fetch('/api/etherscan/verify-indexio-v338',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:target.kind,address:target.address,constructorArguments:target.constructorArguments,mode:current==='pending'&&guid?'check':'verify',guid})});const body=await response.json().catch(()=>({error:'Etherscan returned an unreadable response.'}));if(!response.ok)throw Error(body.error||'Etherscan verification failed.');const status:VerifyState=body.verified?'verified':body.pending?'pending':'idle';setSuite(s=>({...s,verification:{...s.verification,[target.key]:status},verificationGuids:{...s.verificationGuids,[target.key]:body.guid||s.verificationGuids[target.key]||''}}));if(!quiet)setNotice(body.message||`${target.label} verification updated.`);return status}catch(e:any){setSuite(s=>({...s,verification:{...s.verification,[target.key]:'error'}}));if(!quiet)setError(e?.message||String(e));return 'error' as VerifyState}finally{if(!quiet)setBusy('')}
 }
 async function verifyAll(){setBusy('verify-all');setError('');setNotice('Submitting contracts to Etherscan one at a time…');let failures=0;for(const target of verificationTargets){const result=await verifyTarget(target,true);if(result==='error')failures++}setBusy('');if(failures)setError(`${failures} contract verification request${failures===1?'':'s'} failed. Use the individual buttons to see and retry each one.`);else setNotice('All deployed suite contracts were submitted or confirmed on Etherscan/BaseScan.')}
 async function verifyCreatedVault(){if(!vault||vaultConstructorArguments==='0x')return setError('The vault verification data is not available in this session.');setBusy('verify:vault');setVaultVerification('pending');setError('');try{const response=await fetch('/api/etherscan/verify-indexio-v338',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'vault',address:vault,constructorArguments:vaultConstructorArguments})});const body=await response.json().catch(()=>({error:'Etherscan returned an unreadable response.'}));if(!response.ok)throw Error(body.error||'Vault verification failed.');setVaultVerification(body.verified?'verified':'pending');setNotice(body.message||'Vault verification submitted.')}catch(e:any){setVaultVerification('error');setError(e?.message||String(e))}finally{setBusy('')}}

 async function ensureBase(){if(!isConnected){if(!connectors[0])throw Error('No injected wallet found. Install or open MetaMask, then reconnect.');await connectAsync({connector:connectors[0]});return false;}if(chainId!==base.id){await switchChainAsync({chainId:base.id});return false;}if(!wc||!pc)throw Error('Wallet connection is still initializing. Try again.');return true;}
 async function deployContract(key:string,label:string,abi:any,bytecode:Hex,args:any[]):Promise<Address|null>{
   if(!await ensureBase())return null;
   if(!owner)throw Error('Enter a valid protocol owner address first.');
   setBusy(key);setError('');setErrorStep('');setNotice('');
   let submittedHash:Hex|undefined;
   try{const hash=await (wc!.deployContract as any)({abi,bytecode,args,account:wc!.account});submittedHash=hash;setSuite(s=>({...s,transactions:{...s.transactions,[key]:hash}}));setNotice(`${label} submitted. Waiting for Base confirmation…`);const receipt=await pc!.waitForTransactionReceipt({hash,timeout:120_000,pollingInterval:3_000});if(receipt.status!=='success'||!receipt.contractAddress)throw Error(`${label} deployment reverted.`);const deployed=getAddress(receipt.contractAddress);setSuite(s=>({...s,addresses:{...s.addresses,[key]:deployed},transactions:{...s.transactions,[key]:hash},deploymentBlocks:{...s.deploymentBlocks,[key]:receipt.blockNumber.toString()}}));setNotice(`${label} deployed and confirmed on Base.`);return deployed}catch(e:any){const message=e?.shortMessage||e?.message||String(e);setErrorStep(key);setError(submittedHash&&!message.toLowerCase().includes('revert')?`${label} was submitted as ${submittedHash}, but confirmation is taking longer than expected. Do not submit another deployment. Use Refresh and find next step.`:message);return null}finally{setBusy('')}
 }
 async function write(key:string,bindingKey:string,label:string,to:Address,abi:any,functionName:string,args:any[]){
   if(!await ensureBase())return;
   setBusy(key);setError('');setErrorStep('');setNotice('');
   try{const hash=await (wc!.writeContract as any)({address:to,abi,functionName,args,account:wc!.account});setSuite(s=>({...s,transactions:{...s.transactions,[key]:hash}}));const receipt=await pc!.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw Error(`${label} transaction reverted.`);setSuite(s=>({...s,bindings:{...s.bindings,[bindingKey]:true},transactions:{...s.transactions,[key]:hash},deploymentBlocks:{...s.deploymentBlocks,[key]:receipt.blockNumber.toString()}}));setNotice(`${label} confirmed on Base.`)}catch(e:any){setErrorStep(key);setError(e?.shortMessage||e?.message||String(e))}finally{setBusy('')}
 }
 async function refreshDeploymentStatus(scrollToNext=true){
   if(!pc)return setError('Base connection is still initializing. Try refresh again in a moment.');
   setBusy('refresh');setError('');setNotice('Checking the saved addresses and transactions directly on Base…');
   try{
    const next:Suite={...suite,addresses:{...suite.addresses},bindings:{...suite.bindings},transactions:{...suite.transactions},deploymentBlocks:{...suite.deploymentBlocks},candidates:{...suite.candidates},verification:{...suite.verification},verificationGuids:{...suite.verificationGuids}};
    const deploymentKeys=['safety','transferPolicy','codeBlobA','codeBlobB','vaultDeployer','factory','executionRouter','zeroXAdapter','lifiAdapter'];
    for(const key of deploymentKeys){
     const hash=next.transactions[key];
     if(hash&&!next.addresses[key]){try{const receipt=await pc.getTransactionReceipt({hash});if(receipt.status==='success'&&receipt.contractAddress){next.addresses[key]=getAddress(receipt.contractAddress);next.deploymentBlocks[key]=receipt.blockNumber.toString()}}catch{}}
     if(!next.addresses[key]&&next.candidates[key]){try{const code=await pc.getBytecode({address:next.candidates[key]});if(code&&code!=='0x')next.addresses[key]=getAddress(next.candidates[key])}catch{}}
    }
    const receiptBindings:[string,string][]=[['safetyBind','safety'],['deployerBind','deployer'],['wireZeroX','zeroX'],['wireLifi','lifi'],['factoryRouter','factoryRouter']];
    for(const [txKey,bindingKey] of receiptBindings){const hash=next.transactions[txKey];if(hash&&!next.bindings[bindingKey]){try{const receipt=await pc.getTransactionReceipt({hash});if(receipt.status==='success'){next.bindings[bindingKey]=true;next.deploymentBlocks[txKey]=receipt.blockNumber.toString()}}catch{}}}
    if(next.addresses.codeBlobA){try{const code=await pc.getBytecode({address:next.addresses.codeBlobA});if(code?.toLowerCase()!==`0x00${codeParts[0].slice(2)}`.toLowerCase())throw Error('Segment A exists but does not match the compiled vault code.');}catch(e:any){if(e?.message?.includes('does not match'))throw e}}
    if(next.addresses.codeBlobB){try{const code=await pc.getBytecode({address:next.addresses.codeBlobB});if(code?.toLowerCase()!==`0x00${codeParts[1].slice(2)}`.toLowerCase())throw Error('Segment B exists but does not match the compiled vault code.');}catch(e:any){if(e?.message?.includes('does not match'))throw e}}
    if(next.addresses.safety&&next.addresses.factory){try{const [locked,factory]=await Promise.all([pc.readContract({address:next.addresses.safety,abi:indexioV338SafetyControllerAbi,functionName:'factoryLocked'}),pc.readContract({address:next.addresses.safety,abi:indexioV338SafetyControllerAbi,functionName:'factory'})]);next.bindings.safety=Boolean(locked)&&String(factory).toLowerCase()===next.addresses.factory.toLowerCase()}catch{}}
    if(next.addresses.vaultDeployer&&next.addresses.factory){try{const [locked,factory]=await Promise.all([pc.readContract({address:next.addresses.vaultDeployer,abi:indexioV338VaultDeployerAbi,functionName:'factoryLocked'}),pc.readContract({address:next.addresses.vaultDeployer,abi:indexioV338VaultDeployerAbi,functionName:'canonicalFactory'})]);next.bindings.deployer=Boolean(locked)&&String(factory).toLowerCase()===next.addresses.factory.toLowerCase()}catch{}}
    if(next.addresses.executionRouter&&next.addresses.zeroXAdapter){try{next.bindings.zeroX=Boolean(await pc.readContract({address:next.addresses.executionRouter,abi:indexioV338ExecutionRouterAbi,functionName:'approvedAdapter',args:[next.addresses.zeroXAdapter]}))}catch{}}
    if(next.addresses.executionRouter&&next.addresses.lifiAdapter){try{next.bindings.lifi=Boolean(await pc.readContract({address:next.addresses.executionRouter,abi:indexioV338ExecutionRouterAbi,functionName:'approvedAdapter',args:[next.addresses.lifiAdapter]}))}catch{}}
    if(next.addresses.factory&&next.addresses.executionRouter){try{const [locked,router]=await Promise.all([pc.readContract({address:next.addresses.factory,abi:indexioV338FactoryAbi,functionName:'executionRouterLocked'}),pc.readContract({address:next.addresses.factory,abi:indexioV338FactoryAbi,functionName:'executionRouter'})]);next.bindings.factoryRouter=Boolean(locked)&&String(router).toLowerCase()===next.addresses.executionRouter.toLowerCase()}catch{}}
    setSuite(next);
    const progress=[
     ['safety',Boolean(next.addresses.safety)],['transferPolicy',Boolean(next.addresses.transferPolicy)],['code',Boolean(next.addresses.codeBlobA&&next.addresses.codeBlobB)],['vaultDeployer',Boolean(next.addresses.vaultDeployer)],['factory',Boolean(next.addresses.factory)],['safetyBind',Boolean(next.bindings.safety)],['deployerBind',Boolean(next.bindings.deployer)],['executionRouter',Boolean(next.addresses.executionRouter)],['zeroXAdapter',Boolean(next.addresses.zeroXAdapter)],['lifiAdapter',Boolean(next.addresses.lifiAdapter)],['wireZeroX',Boolean(next.bindings.zeroX)],['wireLifi',Boolean(next.bindings.lifi)],['factoryRouter',Boolean(next.bindings.factoryRouter)]
    ] as const;
    const unfinished=progress.find(([,done])=>!done);
    setNotice(unfinished?'Base status refreshed. The next unfinished step is highlighted below.':'Base status refreshed. Every deployment and wiring step is confirmed.');
    if(scrollToNext&&unfinished)setTimeout(()=>document.getElementById(`deploy-step-${unfinished[0]}`)?.scrollIntoView({behavior:'smooth',block:'center'}),80);
   }catch(e:any){setError(e?.shortMessage||e?.message||String(e))}finally{setBusy('')}
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
     const deployed=getAddress(found);const creator=getAddress(wc!.account.address);const vaultCtor=encodeAbiParameters([{type:'address'},{type:'address'},{type:'string'},{type:'string'},{type:'address[]'},{type:'uint16[]'},{type:'uint16'},{type:'uint16'},{type:'uint16'},{type:'uint256'}],[suite.addresses.factory,creator,name.trim(),symbol.trim(),assets,weights,cfee,rew,dist,1000000000000000000n]);setVaultConstructorArguments(vaultCtor);setVaultVerification('idle');setVault(deployed);setTab('create');setNotice('Index created. Continue to the 25 USDC seed step.');
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
  ['safetyBind','6 · Bind Safety to Factory',()=>write('safetyBind','safety','Safety → Factory',suite.addresses.safety,indexioV338SafetyControllerAbi,'setFactoryOnce',[suite.addresses.factory]),!!suite.bindings.safety],
  ['deployerBind','7 · Bind Vault Deployer to Factory',()=>write('deployerBind','deployer','Vault Deployer → Factory',suite.addresses.vaultDeployer,indexioV338VaultDeployerAbi,'setFactoryOnce',[suite.addresses.factory]),!!suite.bindings.deployer],
  ['executionRouter','8 · Execution Router',deployRouter,!!suite.addresses.executionRouter],
  ['zeroXAdapter','9 · 0x Restricted Adapter',()=>deployAdapter('zeroXAdapter'),!!suite.addresses.zeroXAdapter],
  ['lifiAdapter','10 · LI.FI Restricted Adapter',()=>deployAdapter('lifiAdapter'),!!suite.addresses.lifiAdapter],
  ['wireZeroX','11 · Approve 0x adapter',()=>write('wireZeroX','zeroX','0x adapter approval',suite.addresses.executionRouter,indexioV338ExecutionRouterAbi,'setAdapter',[suite.addresses.zeroXAdapter,true]),!!suite.bindings.zeroX],
  ['wireLifi','12 · Approve LI.FI adapter',()=>write('wireLifi','lifi','LI.FI adapter approval',suite.addresses.executionRouter,indexioV338ExecutionRouterAbi,'setAdapter',[suite.addresses.lifiAdapter,true]),!!suite.bindings.lifi],
  ['factoryRouter','13 · Lock Factory to Execution Router',()=>write('factoryRouter','factoryRouter','Factory → Execution Router lock',suite.addresses.factory,indexioV338FactoryAbi,'setExecutionRouterOnce',[suite.addresses.executionRouter]),!!suite.bindings.factoryRouter],
 ];
 const url=(a:string)=>`${EXPLORER}/address/${a}`;

 return <main className="shell">
  <header className="hero"><div className="brandRow"><div className="mark">I</div><div><div className="eyebrow">INDEXIO · BASE MAINNET · V3.3.8</div><div className="networkPill"><i/>Compact vault creation</div></div></div><h1>Indexio contract suite</h1><p>Reuse the existing Asset Registry. Store the verified vault creation code once, then create every index with a small MetaMask request.</p></header>
  <section className="walletBox"><div><span>WALLET</span><b>{isConnected?short(address||''): 'Not connected'} · {chainId===base.id?'Base':'Switch to Base'}</b></div><button className="ghost compact" onClick={async()=>{try{if(!isConnected&&connectors[0])await connectAsync({connector:connectors[0]});else if(chainId!==base.id)await switchChainAsync({chainId:base.id})}catch(e:any){setError(e?.shortMessage||e?.message||String(e))}}}>{isConnected?(chainId===base.id?'Connected':'Switch network'):'Connect MetaMask'}</button></section>
  <div className="statusGrid"><article><span>ASSET REGISTRY</span><b>Reused</b><small>{short(REGISTRY)}</small></article><article><span>VAULT CODE</span><b>{indexioV338VaultCreationCodeLength.toLocaleString()} bytes</b><small>Stored across {codeParts.length} immutable segments</small></article></div>
  <nav className="tabs"><button className={tab==='suite'?'selected':'ghost'} onClick={()=>setTab('suite')}>Contract suite</button><button className={tab==='create'?'selected':'ghost'} onClick={()=>setTab('create')}>Create index</button></nav>
  {tab==='suite'?<>
   <section className="card"><div className="stepHead"><div className="stepNo">SETUP</div><div><h2>Deployment record</h2><p>Saved on this device as you go. Each deployment and wiring action is a separate wallet confirmation, so you can resume after a refresh.</p></div></div>
    <label className="field">Protocol owner<input value={suite.owner} onChange={e=>setSuite(s=>({...s,owner:e.target.value}))} placeholder="0x…"/></label><label className="field">Fee treasury<input value={suite.treasury} onChange={e=>setSuite(s=>({...s,treasury:e.target.value}))} placeholder="0x…"/></label><div className="notice">USDC is fixed to Base USDC. Registry is fixed to the existing Indexio Asset Registry. Verify both addresses before deploying.</div><button className="secondary" style={{marginTop:12}} disabled={!!busy||!pc} onClick={()=>refreshDeploymentStatus(true)}>{busy==='refresh'?'Checking Base…':'Refresh all deployment statuses'}</button>
   </section>
   {rows.map(([key,label,action,done],i)=>{const blocked=(i>0&&!rows.slice(0,i).every(r=>r[3] as boolean))||!owner||!treasury;const isBlob=key==='code';return <section className="card" id={`deploy-step-${String(key)}`} key={String(key)}><div className="stepHead"><div className="stepNo">{String(i+1).padStart(2,'0')}</div><div><h2>{label as string}</h2><p>{done?'Confirmed on Base and recorded on this device.':isBlob?`Two small one-time storage deployments; each segment is at most ${MAX_CHUNK_BYTES.toLocaleString()} bytes.`:'Continue one confirmed Base transaction at a time.'}</p></div></div>{key==='factory'&&<div className="candidate">Factory uses the new Vault Deployer and the existing Asset Registry. It must be new because the current factory permanently points to the V3.3.7 deployer.</div>}{key==='code'&&<div className="details"><div><span>Segment A</span><code>{suite.addresses.codeBlobA||'Not deployed'}</code></div><div><span>Segment B</span><code>{suite.addresses.codeBlobB||'Not deployed'}</code></div></div>}{done&&suite.addresses[String(key)]&&<a className="linkButton" href={url(suite.addresses[String(key)])} target="_blank" rel="noreferrer">View on BaseScan ↗</a>}{!done&&<button className="primary deploy" disabled={blocked||!!busy||!baseReady} onClick={()=>{setError('');setErrorStep('');(action as ()=>Promise<void>)().catch((e:any)=>{setErrorStep(String(key));setError(e?.message||String(e))})}}>{busy===key?`Waiting for ${label as string}…`:busy?'Another transaction is pending':`Continue: ${label as string}`}</button>}{errorStep===String(key)&&error&&<div role="alert" className="notice danger" style={{marginTop:10}}>{error}</div>}<button className="ghost compact" style={{marginTop:10}} disabled={!!busy||!pc} onClick={()=>refreshDeploymentStatus(true)}>{busy==='refresh'?'Checking Base…':'Refresh and find next step'}</button></section>})}
   <section className="card"><div className="stepHead"><div className="stepNo">VERIFY</div><div><h2>Etherscan verification</h2><p>Uses the server-side Etherscan V2 route. Add <code>ETHERSCAN_API_KEY</code> in Vercel, redeploy once, then verify these same deployed addresses.</p></div></div>
    {verificationTargets.length===0?<div className="notice">Deployed contracts will appear here automatically.</div>:verificationTargets.map(target=>{const status=suite.verification[target.key]||'idle';return <div className="deploymentRecordRow" key={target.key}><div><span>{target.label.toUpperCase()}</span><strong>{target.address}</strong><small className={status==='verified'?'good':status==='error'?'bad':''}>{status==='verified'?'Verified on BaseScan ✓':status==='pending'?'Verification processing…':status==='error'?'Verification needs retry':'Not verified yet'}</small></div><button className="ghost compact" disabled={!!busy} onClick={()=>verifyTarget(target)}>{busy===`verify:${target.key}`?'Checking…':status==='verified'?'Check again':status==='pending'?'Check status':'Verify source'}</button></div>})}
    <button className="secondary" style={{marginTop:12}} disabled={!!busy||verificationTargets.length===0} onClick={verifyAll}>{busy==='verify-all'?'Verifying contracts…':'Verify all deployed contracts'}</button>
   </section>
   <section className="card"><div className="stepHead"><div className="stepNo">COPY</div><div><h2>Indexio app integration record</h2><p>Copy the readable deployment record for your notes or the JSON configuration for wiring this release into Indexio later.</p></div></div>
    <div className="details"><div><span>Factory</span><code>{suite.addresses.factory||'Not deployed'}</code></div><div><span>Vault deployer</span><code>{suite.addresses.vaultDeployer||'Not deployed'}</code></div><div><span>Execution router</span><code>{suite.addresses.executionRouter||'Not deployed'}</code></div><div><span>Vault code hash</span><code>{indexioV338VaultCreationCodeHash}</code></div></div>
    <button className="primary" style={{marginTop:12}} onClick={()=>copyText(deploymentRecord,'Complete deployment record copied.')}>Copy deployment record</button><button className="ghost" style={{marginTop:10}} onClick={()=>copyText(JSON.stringify(integrationData,null,2),'Indexio app integration JSON copied.')}>Copy app integration JSON</button>
   </section>
  </>:<>
   {vault?<section className="card"><div className="stepHead"><div className="stepNo">DONE</div><div><h2>Your index is ready to seed</h2><p>The vault is confirmed on Base. The required seed is at least 25 USDC.</p></div></div><div className="contractBox"><span>VAULT ADDRESS</span><strong>{vault}</strong></div><a className="linkButton" href={`${EXPLORER}/address/${vault}`} target="_blank" rel="noreferrer">View vault on BaseScan ↗</a><button className="ghost" style={{marginTop:10}} disabled={!!busy||vaultVerification==='verified'} onClick={verifyCreatedVault}>{busy==='verify:vault'?'Verifying vault…':vaultVerification==='verified'?'Vault source verified ✓':'Verify vault source on BaseScan'}</button><a className="primary linkButton" href={`https://www.indexio.world/indexes/onchain/${vault}`} target="_blank" rel="noreferrer">Continue to 25 USDC seed ↗</a><button className="ghost" style={{marginTop:10}} onClick={()=>setVault('')}>Create another index</button></section>:<section className="card"><div className="stepHead"><div className="stepNo">NEW</div><div><h2>Create an index</h2><p>Configuration is checked against the on-chain Asset Registry before MetaMask is asked to confirm the compact deployer call.</p></div></div>
    <label className="field">Index name<input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Base Dividend Leaders"/></label><label className="field">Share symbol<input value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} placeholder="e.g. BDL" maxLength={12}/></label>
    {assetRows.map((x,i)=><div className="assetRow" key={i}><label className="field">Asset {i+1} contract<input value={x.asset} onChange={e=>updateRow(i,'asset',e.target.value)} placeholder="Base token address"/></label><label className="field">Weight (bps)<input value={x.weight} onChange={e=>updateRow(i,'weight',e.target.value)} inputMode="numeric" placeholder="e.g. 2500"/></label>{assetRows.length>1&&<button className="ghost compact remove" onClick={()=>setAssetRows(r=>r.filter((_,j)=>j!==i))}>Remove</button>}</div>)}
    {assetRows.length<20&&<button className="ghost" style={{marginTop:10}} onClick={addAsset}>Add another asset</button>}
    <div className="formGrid"><label className="field">Creator fee (bps, max 100)<input value={creatorFee} onChange={e=>setCreatorFee(e.target.value)} inputMode="numeric"/></label><label className="field">Income reward (bps, max 2,000)<input value={reward} onChange={e=>setReward(e.target.value)} inputMode="numeric"/></label><label className="field">Payout share (bps)<input value={distribution} onChange={e=>setDistribution(e.target.value)} inputMode="numeric"/></label></div>
    <div className="details"><div><span>Weight total</span><strong>{assetRows.reduce((a,x)=>a+(Number(x.weight)||0),0).toLocaleString()} / 10,000 bps</strong></div><div><span>Wallet calldata</span><strong>Constructor bytecode stays on-chain</strong></div></div>
    <button className="primary deploy" style={{marginTop:14}} disabled={!baseReady||!!busy||assetRows.reduce((a,x)=>a+(Number(x.weight)||0),0)!==10000} onClick={createIndex}>{busy==='create'?'Validating and creating…':'Validate configuration and create index'}</button>
   </section>}
  </>}
  {notice&&<div role="status" className="notice success">{notice}</div>}{error&&!errorStep&&<div role="alert" className="notice danger">{error}</div>}
  <footer>Before deployment, independently verify the V3.3.8 source and the reused registry address. The code segments are immutable and checked against the compiled vault creation-code hash. Vault creation still costs network gas; this change keeps the large bytecode out of each user's MetaMask request.</footer>
 </main>
}
