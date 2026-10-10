'use client';

import Link from 'next/link';
import {useEffect, useMemo, useState} from 'react';
import {useAccount, useConnect, usePublicClient, useSwitchChain, useWalletClient} from 'wagmi';
import {base} from 'viem/chains';
import {encodeAbiParameters, getAddress, isAddress, keccak256, padHex, stringToHex, type Address, type Hex} from 'viem';
import {
  adaptiveBuyRouterAbi,adaptiveBuyRouterBytecode,adaptiveBuyRouterCodeHash,
  adaptiveBuyZeroXAbi,adaptiveBuyZeroXBytecode,adaptiveBuyZeroXCodeHash,
  adaptiveBuyLifiAbi,adaptiveBuyLifiBytecode,adaptiveBuyLifiCodeHash,
} from '../lib/indexio-adaptive-buy.generated';

const FACTORY=getAddress('0x0dB41D4B3221bD4244A83Da39e0eF91a706a0e62');
const REGISTRY=getAddress('0x5C4791e3B752d9b084E8FD76932E82C2031f15c1');
const USDC=getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const SAFETY=getAddress('0xaa3D6F215DeAf871759936D19F157104fFE9644D');
const TRANSFER_POLICY=getAddress('0x311E4894b50484d10641133609D44668E627585c');
const OWNER=getAddress('0x3118FE32B27651734fe4D966D1bC240bE6e3139D');
const ORIGINAL_ROUTER=getAddress('0x38476748A9197F0eF02A812948F123E892Ac8aca');
const VAULT_DEPLOYER=getAddress('0x372A68bF3dc1b5B416f3849A7df502b706805A8a');
const TREASURY=OWNER;
const RELEASE_ID=keccak256(stringToHex('INDEXIO_V3_3_6_HARDENED_RC'));
const LOCAL_KEY='indexio:v338:adaptive-buy-deployer:v1';
const VAULT_ABI=[
  {type:'function',name:'seeded',stateMutability:'view',inputs:[],outputs:[{type:'bool'}]},
  {type:'function',name:'closed',stateMutability:'view',inputs:[],outputs:[{type:'bool'}]},
  {type:'function',name:'assets',stateMutability:'view',inputs:[],outputs:[{type:'address[]'}]},
  {type:'function',name:'shareToken',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'factory',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'executionRouter',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'MAX_DEPOSIT_IMBALANCE_BPS',stateMutability:'view',inputs:[],outputs:[{type:'uint16'}]},
] as const;
const SHARE_TOKEN_ABI=[
  {type:'function',name:'vault',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'totalSupply',stateMutability:'view',inputs:[],outputs:[{type:'uint256'}]},
] as const;
const BINDING_ABI=[
  {type:'function',name:'factory',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'factoryLocked',stateMutability:'view',inputs:[],outputs:[{type:'bool'}]},
] as const;
const DEPLOYER_BINDING_ABI=[
  {type:'function',name:'canonicalFactory',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'factoryLocked',stateMutability:'view',inputs:[],outputs:[{type:'bool'}]},
] as const;
const VAULT_FACTORY_ABI=[{type:'function',name:'isVault',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'bool'}]}] as const;
const POLICY_ABI=[
  {type:'function',name:'expectedReceiveBps',stateMutability:'view',inputs:[{name:'asset',type:'address'}],outputs:[{type:'uint16'}]},
  {type:'function',name:'setPolicy',stateMutability:'nonpayable',inputs:[{name:'asset',type:'address'},{name:'receiveBps',type:'uint16'}],outputs:[]},
  {type:'function',name:'clearPolicy',stateMutability:'nonpayable',inputs:[{name:'asset',type:'address'}],outputs:[]},
] as const;
const FACTORY_ABI=[
  {type:'function',name:'registry',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'vaultDeployer',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'feeTreasury',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'owner',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'settlementToken',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'safetyController',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'transferPolicy',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'executionRouter',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'executionRouterLocked',stateMutability:'view',inputs:[],outputs:[{type:'bool'}]},
] as const;
const short=(a:string)=>a?`${a.slice(0,8)}…${a.slice(-6)}`:'Not deployed';
const same=(a:unknown,b:string)=>String(a||'').toLowerCase()===b.toLowerCase();
type Saved={router:string;zeroX:string;lifi:string;txs:Record<string,Hex>};
const BLANK:Saved={router:'',zeroX:'',lifi:'',txs:{}};
type Status={factoryOk:boolean;routerOk:boolean;zeroXOk:boolean;lifiOk:boolean;zeroXApproved:boolean;lifiApproved:boolean;zeroXPending:number;lifiPending:number;zeroXRelease:boolean;lifiRelease:boolean;paused:boolean;factoryMessage:string};
const EMPTY_STATUS:Status={factoryOk:false,routerOk:false,zeroXOk:false,lifiOk:false,zeroXApproved:false,lifiApproved:false,zeroXPending:0,lifiPending:0,zeroXRelease:false,lifiRelease:false,paused:false,factoryMessage:'Not checked yet'};

type Key='router'|'zeroX'|'lifi';
export function IndexioAdaptiveBuyDeployer(){
  const {address,chainId,isConnected}=useAccount();
  const {connectAsync,connectors}=useConnect();
  const {switchChainAsync}=useSwitchChain();
  const pc=usePublicClient({chainId:base.id});
  const {data:wallet}=useWalletClient({chainId:base.id});
  const [saved,setSaved]=useState<Saved>(BLANK);
  const [hydrated,setHydrated]=useState(false);
  const [status,setStatus]=useState<Status>(EMPTY_STATUS);
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [target,setTarget]=useState('');
  const [spender,setSpender]=useState('');
  const [selector,setSelector]=useState('');
  const [lifiStatus,setLifiStatus]=useState('');

  const [acknowledge,setAcknowledge]=useState(false);
  const [testVault,setTestVault]=useState('');
  const [vaultCheck,setVaultCheck]=useState('');
  const [vaultVerified,setVaultVerified]=useState(false);
  const [taxAsset,setTaxAsset]=useState('');
  const [taxBps,setTaxBps]=useState('9900');
  const [taxOnchain,setTaxOnchain]=useState<number|null>(null);
  const [ackTaxChange,setAckTaxChange]=useState(false);
  const [verifyState,setVerifyState]=useState<Record<string,{guid:string;status:string}>>({});
  const ownerConnected=Boolean(address&&same(address,OWNER));
  const onBase=chainId===base.id;
  const adapters=useMemo(()=>[{key:'zeroX' as Key,label:'Restricted 0x adapter',address:saved.zeroX,ok:status.zeroXOk,approved:status.zeroXApproved,pending:status.zeroXPending},{key:'lifi' as Key,label:'Restricted LI.FI adapter (optional)',address:saved.lifi,ok:status.lifiOk,approved:status.lifiApproved,pending:status.lifiPending}],[saved,status]);
  const record=`INDEXIO V3.3.8 ADAPTIVE BUY — BASE MAINNET\nRelease status: UNTESTED / NOT AUDITED until independent review and Base-fork tests\nFactory: ${FACTORY}\nUSDC: ${USDC}\nOriginal execution router (unchanged): ${ORIGINAL_ROUTER}\nVault deployer: ${VAULT_DEPLOYER}\nNew adaptive buy router: ${saved.router||'NOT DEPLOYED'}\nNew 0x restricted adapter: ${saved.zeroX||'NOT DEPLOYED'}\nNew LI.FI restricted adapter: ${saved.lifi||'NOT DEPLOYED'}\nOwner: ${OWNER}\nRouter max leftover/refund ceiling: 3000 bps (30%), user sets lower amount per trade\nRouter max swap deviation ceiling: 1000 bps (10%), user minimum output enforced\nExisting vault proportionality: immutable 100 bps (1%)\nTransfer policy: ${TRANSFER_POLICY} (up to 20% configured per-transfer loss)\n0x approved: ${status.zeroXApproved?'YES':'NO'}\nLI.FI approved: ${status.lifiApproved?'YES':'NO'}\nRouter paused: ${status.paused?'YES':'NO'}\nFactory wiring independently checked: ${status.factoryOk?'YES':'NO'}\nVault ${testVault||'(not specified)'} checked: ${vaultVerified?'YES':'NO'}\nIndexio regular-buy UI switched: NO (separate app change required)\n`; 

  useEffect(()=>{try{const raw=localStorage.getItem(LOCAL_KEY);if(raw){const data=JSON.parse(raw);setSaved({router:String(data.router||''),zeroX:String(data.zeroX||''),lifi:String(data.lifi||''),txs:data.txs||{}})}}catch{}finally{setHydrated(true)}},[]);
  useEffect(()=>{if(hydrated)try{localStorage.setItem(LOCAL_KEY,JSON.stringify(saved))}catch{}},[saved,hydrated]);
  const addressOf=(key:Key):Address|null=>isAddress(saved[key])?getAddress(saved[key]):null;
  const checkCode=async(a:Address)=>{const code=await pc!.getBytecode({address:a});return Boolean(code&&code!=='0x')};
  async function readStatus(){
    if(!pc)return;
    setBusy('read');setError('');
    try{
      const [chain,registry,usdc,safety,policy,oldRouter,locked,vaultDeployer,treasury,factoryOwner,safetyFactory,safetyLocked,deployerFactory,deployerLocked]=await Promise.all([
        pc.getChainId(),
        pc.readContract({address:FACTORY,abi:FACTORY_ABI,functionName:'registry'}),
        pc.readContract({address:FACTORY,abi:FACTORY_ABI,functionName:'settlementToken'}),
        pc.readContract({address:FACTORY,abi:FACTORY_ABI,functionName:'safetyController'}),
        pc.readContract({address:FACTORY,abi:FACTORY_ABI,functionName:'transferPolicy'}),
        pc.readContract({address:FACTORY,abi:FACTORY_ABI,functionName:'executionRouter'}),
        pc.readContract({address:FACTORY,abi:FACTORY_ABI,functionName:'executionRouterLocked'}),
        pc.readContract({address:FACTORY,abi:FACTORY_ABI,functionName:'vaultDeployer'}),
        pc.readContract({address:FACTORY,abi:FACTORY_ABI,functionName:'feeTreasury'}),
        pc.readContract({address:FACTORY,abi:FACTORY_ABI,functionName:'owner'}),
        pc.readContract({address:SAFETY,abi:BINDING_ABI,functionName:'factory'}),
        pc.readContract({address:SAFETY,abi:BINDING_ABI,functionName:'factoryLocked'}),
        pc.readContract({address:VAULT_DEPLOYER,abi:DEPLOYER_BINDING_ABI,functionName:'canonicalFactory'}),
        pc.readContract({address:VAULT_DEPLOYER,abi:DEPLOYER_BINDING_ABI,functionName:'factoryLocked'}),
      ]);
      const ok=chain===8453&&same(registry,REGISTRY)&&same(usdc,USDC)&&same(safety,SAFETY)&&same(policy,TRANSFER_POLICY)&&same(oldRouter,ORIGINAL_ROUTER)&&locked&&same(vaultDeployer,VAULT_DEPLOYER)&&same(treasury,TREASURY)&&same(factoryOwner,OWNER)&&same(safetyFactory,FACTORY)&&safetyLocked&&same(deployerFactory,FACTORY)&&deployerLocked;
      const s:Status={...EMPTY_STATUS,factoryOk:ok,factoryMessage:ok?'Verified V3.3.8 Factory, owner, treasury, compact vault deployer, safety binding, router lock, registry, USDC and transfer policy. No transaction sent.':'V3.3.8 Factory or its bound dependencies differ from the expected addresses or locks. STOP. Do not deploy or approve adapters.'};
      if(ok&&addressOf('router')&&await checkCode(addressOf('router')!)){
        const a=addressOf('router')!;
        const [f,u,ownerAddr,paused,oldRouterPin,deployerPin]=await Promise.all([
          pc.readContract({address:a,abi:adaptiveBuyRouterAbi,functionName:'factory'}),
          pc.readContract({address:a,abi:adaptiveBuyRouterAbi,functionName:'settlementToken'}),
          pc.readContract({address:a,abi:adaptiveBuyRouterAbi,functionName:'owner'}),
          pc.readContract({address:a,abi:adaptiveBuyRouterAbi,functionName:'buysPaused'}),
          pc.readContract({address:a,abi:adaptiveBuyRouterAbi,functionName:'ORIGINAL_EXECUTION_ROUTER'}),
          pc.readContract({address:a,abi:adaptiveBuyRouterAbi,functionName:'CANONICAL_VAULT_DEPLOYER'}),
        ]);
        s.routerOk=same(f,FACTORY)&&same(u,USDC)&&same(ownerAddr,OWNER)&&same(oldRouterPin,ORIGINAL_ROUTER)&&same(deployerPin,VAULT_DEPLOYER);
        s.paused=Boolean(paused);
        if(s.routerOk){for(const k of ['zeroX','lifi'] as const){const adapter=addressOf(k);if(!adapter||!await checkCode(adapter))continue;
          const abi=k==='zeroX'?adaptiveBuyZeroXAbi:adaptiveBuyLifiAbi;
          const [caller,release,approved,pending]=await Promise.all([
            pc.readContract({address:adapter,abi,functionName:'callerRouter'}),
            pc.readContract({address:adapter,abi,functionName:'RELEASE_ID'}),
            pc.readContract({address:a,abi:adaptiveBuyRouterAbi,functionName:'approvedAdapter',args:[adapter]}),
            pc.readContract({address:a,abi:adaptiveBuyRouterAbi,functionName:'pendingAdapterValidAt',args:[adapter]}),
          ]);
          const valid=same(caller,a)&&same(release,RELEASE_ID);
          if(k==='zeroX'){s.zeroXOk=valid;s.zeroXApproved=valid&&Boolean(approved);s.zeroXRelease=same(release,RELEASE_ID);s.zeroXPending=Number(pending)}
          else{s.lifiOk=valid;s.lifiApproved=valid&&Boolean(approved);s.lifiRelease=same(release,RELEASE_ID);s.lifiPending=Number(pending)}
        }}
      }
      setStatus(s);
      if(!ok)setError(s.factoryMessage);else setMessage('On-chain deployment state refreshed. No transactions were sent.');
    }catch(e:any){setStatus({...EMPTY_STATUS,factoryMessage:'Read-only verification failed'});setError(e?.shortMessage||e?.message||String(e))}
    finally{setBusy('')}
  }
  useEffect(()=>{if(hydrated&&pc)void readStatus()},[hydrated,pc,saved.router,saved.zeroX,saved.lifi]); // eslint-disable-line react-hooks/exhaustive-deps

  async function recoverDeploymentReceipts(){
    if(!pc||busy)return;
    setBusy('recover');setError('');
    try{
      let pending=0,restored=0,failed=0;
      const pendingMap:Partial<Record<Key,Address>>={};
      const failedKeys:string[]=[];
      for(const key of ['router','zeroX','lifi'] as const){
        const h=saved.txs[key];if(!h||addressOf(key))continue;
        try{
          const receipt=await pc.getTransactionReceipt({hash:h});
          if(receipt.status==='success'&&receipt.contractAddress){pendingMap[key]=getAddress(receipt.contractAddress);restored++}
          else if(receipt.status==='reverted'){failedKeys.push(key);failed++}
        }catch{pending++}
      }
      if(restored||failed){setSaved(s=>{
        const txs={...s.txs};for(const k of failedKeys)delete txs[k];
        return {...s,...pendingMap,txs};
      });}
      setMessage(`Receipt recovery: ${restored} deployed, ${failed} confirmed reverted, ${pending} still without receipt. No transactions sent.`);
    }catch(e:any){setError(e?.message||String(e))}finally{setBusy('')}
  }
  async function ensureOwner(){
    if(!isConnected){if(connectors[0])await connectAsync({connector:connectors[0],chainId:base.id});throw Error('Connect the protocol-owner wallet and confirm Base before proceeding.');}
    if(!onBase){await switchChainAsync({chainId:base.id});throw Error('Wallet switched to Base. Check the network and press the action again.');}
    if(!ownerConnected)throw Error('Only the deployed protocol-owner wallet can manage this candidate.');
    if(!wallet||!pc)throw Error('Wallet connection is still initializing.');
    if(!status.factoryOk)throw Error('Run the free Factory verification first.');
  }
  async function send(name:string,fn:()=>Promise<Hex>,isDeploy=false,key?:Key){
    if(busy) return;
    setBusy(name);setError('');setMessage('');
    try{
      await ensureOwner();
      const priorHash=saved.txs[name];
      if(priorHash){
        let receipt;
        try{receipt=await pc!.getTransactionReceipt({hash:priorHash})}catch{throw Error(`A previous ${name} transaction (${short(priorHash)}) has no confirmed receipt. Check BaseScan or use Recover receipts before another wallet request.`)}
        if(receipt.status==='success')throw Error(`${name} already confirmed (${short(priorHash)}). Refresh on-chain state before another wallet request.`);
        // Reverted transactions are safely terminal; a corrected action can be attempted.
      }
      const hash=await fn();
      setSaved(s=>({...s,txs:{...s.txs,[name]:hash}}));
      setMessage(`${name} submitted (${short(hash)}). Waiting for the confirmed Base receipt. Do not resend while pending.`);
      const receipt=await pc!.waitForTransactionReceipt({hash,timeout:150_000,pollingInterval:3000});
      if(receipt.status!=='success')throw Error(`Transaction ${short(hash)} reverted. Do not repeat without checking BaseScan.`);
      if(isDeploy){
        if(!receipt.contractAddress||!key)throw Error(`Receipt ${hash} confirmed but contains no contract address. Check BaseScan.`);
        const a=getAddress(receipt.contractAddress);
        setSaved(s=>({...s,[key]:a}));
        setMessage(`${name} deployed: ${a}. Read-only verification will run next.`);
      }else setMessage(`${name} confirmed in block ${receipt.blockNumber.toString()}. Refreshing permissions…`);
    }catch(e:any){setError(e?.shortMessage||e?.message||String(e))}
    finally{setBusy('')}
  }
  const deployRouter=()=>send('router',()=>wallet!.deployContract({abi:adaptiveBuyRouterAbi,bytecode:adaptiveBuyRouterBytecode,args:[OWNER,FACTORY],account:wallet!.account,chain:base}),true,'router');
  const deployZero=()=>send('zeroX',()=>wallet!.deployContract({abi:adaptiveBuyZeroXAbi,bytecode:adaptiveBuyZeroXBytecode,args:[addressOf('router')!],account:wallet!.account,chain:base}),true,'zeroX');
  const deployLifi=()=>send('lifi',()=>wallet!.deployContract({abi:adaptiveBuyLifiAbi,bytecode:adaptiveBuyLifiBytecode,args:[OWNER,addressOf('router')!],account:wallet!.account,chain:base}),true,'lifi');
  const write=async(label:string,abi:any,to:Address,fn:string,args:any[]=[])=>send(label,()=> (wallet!.writeContract as any)({address:to,abi,functionName:fn,args,account:wallet!.account,chain:base}));
  const propose=(a:Address)=>write(`propose:${short(a)}`,adaptiveBuyRouterAbi,addressOf('router')!,'proposeAdapter',[a]);
  const activate=(a:Address)=>write(`activate:${short(a)}`,adaptiveBuyRouterAbi,addressOf('router')!,'activateAdapter',[a]);
  const disable=(a:Address)=>write(`disable:${short(a)}`,adaptiveBuyRouterAbi,addressOf('router')!,'disableAdapter',[a]);
  async function allowLifi(){
    if(!addressOf('lifi')||!status.lifiOk)return setError('Deploy and verify the new LI.FI adapter first.');
    if(!isAddress(target)||!isAddress(spender)||!/^0x[0-9a-fA-F]{8}$/.test(selector))return setError('Enter a verified LI.FI target, spender and 4-byte selector.');
    const t=getAddress(target),s=getAddress(spender),sel=selector as Hex;
    if(!pc)return;
    const [targetCode,spenderCode,finalized]=await Promise.all([
      checkCode(t),checkCode(s),pc.readContract({address:addressOf('lifi')!,abi:adaptiveBuyLifiAbi,functionName:'bootstrapFinalized'})
    ]);
    if(!targetCode||!spenderCode)throw Error('Target/spender must be deployed code contracts on Base.');
    const checks:[string,string,any[],number,Hex,string,string][]=[
      ['allowedTarget','setTarget',[t,true],1,padHex(t,{size:32}),'proposeTarget','activateTarget'],
      ['allowedSpender','setSpender',[s,true],2,padHex(s,{size:32}),'proposeSpender','activateSpender'],
      ['allowedSelector','setSelector',[sel,true],3,padHex(sel,{size:32,dir:'right'}),'proposeSelector','activateSelector'],
      ['allowedTargetSelector','setTargetSelector',[t,sel,true],4,keccak256(encodeAbiParameters([{type:'address'},{type:'bytes4'}],[t,sel])),'proposeTargetSelector','activateTargetSelector'],
    ];
    setLifiStatus('Configure approved infrastructure one permission at a time; review each wallet prompt.');
    for(const [getter,fn,args,kind,keyValue,proposeFn,activateFn] of checks){
      let existing=false;
      if(getter==='allowedTargetSelector'){
        const key=keccak256(encodeAbiParameters([{type:'address'},{type:'bytes4'}],[t,sel]));
        existing=Boolean(await pc.readContract({address:addressOf('lifi')!,abi:adaptiveBuyLifiAbi,functionName:'allowedTargetSelector',args:[key]}));
      }else existing=Boolean(await pc.readContract({address:addressOf('lifi')!,abi:adaptiveBuyLifiAbi,functionName:getter as 'allowedTarget'|'allowedSpender'|'allowedSelector',args:[args[0]]}));
      if(existing)continue;
      // Submit exactly one step per button press. User explicitly confirms every change.
      if(finalized){
        const pendingKey=keccak256(encodeAbiParameters([{type:'uint8'},{type:'bytes32'}],[kind,keyValue]));
        const at=await pc.readContract({address:addressOf('lifi')!,abi:adaptiveBuyLifiAbi,functionName:'pendingInfrastructureValidAt',args:[pendingKey]});
        if(at!==0n&&Date.now()<Number(at)*1000){setLifiStatus(`${getter} is timelocked until ${new Date(Number(at)*1000).toLocaleString()}. No wallet request was sent.`);return}
        await write(`lifi-${at===0n?proposeFn:activateFn}`,adaptiveBuyLifiAbi,addressOf('lifi')!,at===0n?proposeFn:activateFn,getter==='allowedTargetSelector'?[t,sel]:[args[0]]);
        setLifiStatus(`${getter}: ${at===0n?'proposed, activate after six hours':'activation requested'}. Refresh and continue.`);
      }else{
        await write(`lifi-${fn}`,adaptiveBuyLifiAbi,addressOf('lifi')!,fn,args);
        setLifiStatus(`Requested ${fn}. Refresh and continue; existing permissions are skipped next time.`);
      }
      return;
    }
    setLifiStatus('All four LI.FI permissions are confirmed on Base.');
  }
  async function verifyOnBaseScan(key:Key){
    if(busy)return;
    const deployed=addressOf(key);
    if(!deployed)return setError('No contract address to verify.');
    if(key==='router'&&!status.routerOk||key==='zeroX'&&!status.zeroXOk||key==='lifi'&&!status.lifiOk)return setError('Run the on-chain contract identity check first.');
    const kind=key==='router'?'adaptiveBuyRouter':key==='zeroX'?'adaptiveBuyZeroX':'adaptiveBuyLifi';
    const ctor=key==='router'
      ?encodeAbiParameters([{type:'address'},{type:'address'}],[OWNER,FACTORY])
      :key==='zeroX'?encodeAbiParameters([{type:'address'}],[addressOf('router')!])
      :encodeAbiParameters([{type:'address'},{type:'address'}],[OWNER,addressOf('router')!]);
    const previous=verifyState[key];
    setBusy(`verify:${key}`);setError('');
    try{
      const res=await fetch('/api/etherscan/verify-indexio-v338',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,address:deployed,constructorArguments:ctor,mode:previous?.guid?'check':'verify',guid:previous?.guid||''})});
      const data=await res.json();
      if(!res.ok||data.error)throw Error(data.error||'Etherscan verification request failed');
      const next={guid:String(data.guid||previous?.guid||''),status:data.verified?'verified':data.pending?'pending':'not verified'};
      setVerifyState(s=>({...s,[key]:next}));
      setMessage(data.message||`Source verification: ${next.status}`);
    }catch(e:any){setError(e?.message||String(e))}finally{setBusy('')}
  }
  async function checkVaultCompatibility(){
    setVaultVerified(false);
    if(!pc||!isAddress(testVault))return setError('Enter a registered V3.3.8 vault address on Base.');
    if(!status.factoryOk)return setError('Verify the original V3.3.8 Factory first (free).');
    setError('');setVaultCheck('Checking Factory registration, vault binding, share token and deposit eligibility…');
    try{
      const vault=getAddress(testVault);
      const registered=await pc.readContract({address:FACTORY,abi:VAULT_FACTORY_ABI,functionName:'isVault',args:[vault]});
      if(!registered)throw Error('This vault is NOT registered by the canonical V3.3.8 Factory. No adaptive buy is permitted.');
      const [factory,executionRouter,seeded,closed,assets,shareToken,tolerance]=await Promise.all([
        pc.readContract({address:vault,abi:VAULT_ABI,functionName:'factory'}),
        pc.readContract({address:vault,abi:VAULT_ABI,functionName:'executionRouter'}),
        pc.readContract({address:vault,abi:VAULT_ABI,functionName:'seeded'}),
        pc.readContract({address:vault,abi:VAULT_ABI,functionName:'closed'}),
        pc.readContract({address:vault,abi:VAULT_ABI,functionName:'assets'}),
        pc.readContract({address:vault,abi:VAULT_ABI,functionName:'shareToken'}),
        pc.readContract({address:vault,abi:VAULT_ABI,functionName:'MAX_DEPOSIT_IMBALANCE_BPS'}),
      ]);
      if(!same(factory,FACTORY)||!same(executionRouter,ORIGINAL_ROUTER))throw Error('Vault factory or original execution router does not match V3.3.8.');
      if(!seeded||closed)throw Error(`Vault is not available for additional buys (seeded=${seeded}, closed=${closed}).`);
      if(Number(tolerance)!==100)throw Error(`Vault deposit tolerance is ${tolerance} bps, not canonical V3.3.8 (100 bps).`);
      if(assets.length<1||assets.length>20||new Set(assets.map(a=>a.toLowerCase())).size!==assets.length)throw Error('Unexpected vault asset composition.');
      const [shareVault,supply]=await Promise.all([
        pc.readContract({address:shareToken,abi:SHARE_TOKEN_ABI,functionName:'vault'}),
        pc.readContract({address:shareToken,abi:SHARE_TOKEN_ABI,functionName:'totalSupply'}),
      ]);
      if(!same(shareVault,vault)||supply===0n)throw Error('Share token is not bound to this vault or has no supply.');
      setVaultVerified(true);
      setVaultCheck(`V3.3.8 compatible · Factory ${short(factory)} · original sell router ${short(executionRouter)} · ${assets.length} assets · seeded and open · 1% vault tolerance · share token ${short(shareToken)} · supply ${supply.toString()}. Read-only identity checks passed; live buy simulation and security testing are still required.`);
    }catch(e:any){setVaultCheck('Compatibility not confirmed. No transaction sent.');setError(e?.shortMessage||e?.message||String(e));}
  }
  async function readTokenPolicy(){
    if(!pc||!isAddress(taxAsset))return setError('Enter a valid token contract address on Base.');
    setError('');
    try{const rate=await pc.readContract({address:TRANSFER_POLICY,abi:POLICY_ABI,functionName:'expectedReceiveBps',args:[getAddress(taxAsset)]});
      setTaxOnchain(Number(rate));setMessage(`Current configured receive rate: ${Number(rate)/100}% (max expected loss: ${(10000-Number(rate))/100}%). No gas used.`);
    }catch(e:any){setError(e?.shortMessage||e?.message||String(e))}
  }
  const updatePolicy=async()=>{
    const bps=Number(taxBps);
    if(!isAddress(taxAsset)||!Number.isInteger(bps)||bps<8000||bps>10000)return setError('Receive rate must be 8,000–10,000 bps (80–100%).');
    if(!ackTaxChange)return setError('Confirm that you understand this policy affects all V3.3.8 vaults holding the token.');
    if(bps===taxOnchain)return setMessage('This receive rate is already configured.');
    await write(`token-policy:${taxAsset.toLowerCase()}`,POLICY_ABI,TRANSFER_POLICY,'setPolicy',[getAddress(taxAsset),bps]);
    setTaxOnchain(null);setAckTaxChange(false);
  };
  const updateAddress=(key:Key,value:string)=>{setSaved(s=>({...s,[key]:value.trim()}));setStatus(EMPTY_STATUS)};
  const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);setMessage('Copied to clipboard.')}catch{setError('Clipboard blocked. Select and copy the text manually.')}};
  const eligible=hydrated&&status.factoryOk&&ownerConnected&&onBase&&acknowledge;
  const readiness=Boolean(status.factoryOk&&status.routerOk&&status.zeroXApproved&&!status.paused);
  return <main className="shell adaptive-buy-admin">
    <header className="hero"><div className="brandRow"><div className="mark">I</div><div><div className="eyebrow">INDEXIO · V3.3.8 · BASE</div><div className="networkPill"><i/>Adaptive Buy add-on</div></div></div>
      <h1>Buy-router deployment</h1><p>Deploy a separate buy-only router for existing V3.3.8 indexes. The original Factory, seed, sell and governance systems stay unchanged.</p>
      <p><Link href="/" className="linkButton">← Original V3.3.8 deployment console</Link></p>
    </header>
    <section className="card"><div className="stepHead"><div className="stepNo">!</div><div><h2>Understand the limits</h2><p>The maximums below are code ceilings, not recommended trade defaults. Do not deploy an untested contract with real investor funds.</p></div></div>
      <div className="statusGrid"><article><span>USDC refund ceiling</span><b>30%</b><small>Investor can set lower (suggest 5% initially).</small></article><article><span>Quote deviation ceiling</span><b>10%</b><small>Each route still enforces minimum received tokens.</small></article><article><span>Existing vault deposit tolerance</span><b>1% fixed</b><small>Cannot be changed for deployed vaults.</small></article><article><span>Transfer-loss policy</span><b>Up to 20%</b><small>Configured per token in existing policy, actual amounts measured.</small></article></div>
      <label className="check"><input type="checkbox" checked={acknowledge} onChange={e=>setAcknowledge(e.target.checked)}/><span>I understand this is a new, unaudited contract. I will test it on a Base fork and review it before deploying it with funds.</span></label>
    </section>
    <section className="walletBox"><div><span>PROTOCOL OWNER WALLET</span><b>{isConnected?short(address||''):'Not connected'} · {onBase?'Base':'Wrong network'} · {ownerConnected?'Authorized owner':'Owner required'}</b></div>
      {!isConnected?<button className="ghost compact" disabled={!!busy} onClick={()=>connectors[0]&&connectAsync({connector:connectors[0],chainId:base.id}).catch(e=>setError(e?.message||String(e)))}>Connect</button>:!onBase?<button className="ghost compact" disabled={!!busy} onClick={()=>switchChainAsync({chainId:base.id}).catch(e=>setError(e?.message||String(e)))}>Switch Base</button>:null}
    </section>
    <section className="card"><div className="stepHead"><div className="stepNo">01</div><div><h2>Verify the existing Factory</h2><p>Reads Base. No transaction, gas or approval needed.</p></div></div>
      <div className="details"><div><span>Factory</span><code>{FACTORY}</code></div><div><span>Old execution router</span><code>{ORIGINAL_ROUTER}</code></div><div><span>Asset Registry</span><code>{REGISTRY}</code></div><div><span>Protocol owner</span><code>{OWNER}</code></div></div>
      <div className={`notice ${status.factoryOk?'success':'danger'}`}>{status.factoryMessage}</div>
      <button className="ghost" disabled={!!busy} style={{marginTop:12}} onClick={readStatus}>{busy==='read'?'Checking Base…':'Refresh all on-chain status (free)'}</button>
      <button className="ghost" disabled={!!busy} style={{marginTop:9}} onClick={recoverDeploymentReceipts}>Recover saved deployment receipts (free)</button>
    </section>
    <section className="card"><div className="stepHead"><div className="stepNo">02</div><div><h2>Adaptive buy router</h2><p>This router is permanently pinned to the V3.3.8 Factory, owner, vault deployer, safety controller, USDC and original execution router. It deposits only to registered V3.3.8 vaults; it does not replace the Factory's locked router.</p></div></div>
      <label className="field">Router address (paste if previously deployed)<input value={saved.router} onChange={e=>updateAddress('router',e.target.value)} placeholder="0x…"/></label>
      <div className="verifyMeta"><span>{status.routerOk?'Verified on Base':'Not yet verified'}</span><span>Router deployment bytecode: {short(adaptiveBuyRouterCodeHash)}</span></div>
      {status.routerOk&&<button className="ghost" style={{marginTop:9}} disabled={!!busy} onClick={()=>verifyOnBaseScan('router')}>Verify router source on BaseScan {verifyState.router?.status?`(${verifyState.router.status})`:''}</button>}
      {saved.txs.router&&<p className="notice">Last deployment: <a href={`https://basescan.org/tx/${saved.txs.router}`} target="_blank" rel="noreferrer">{short(saved.txs.router)} ↗</a></p>}
      <button className="primary deploy" disabled={!eligible||!!busy||Boolean(saved.router)||Boolean(saved.txs.router)||!wallet} style={{marginTop:12}} onClick={deployRouter}>{busy==='router'?'Deploying…':status.routerOk?'Already deployed':'Deploy adaptive buy router'}</button>
    </section>
    <section className="card"><div className="stepHead"><div className="stepNo">03</div><div><h2>Deploy isolated adapters</h2><p>Existing adapters are bound to your original router. These new instances are locked to the adaptive router. 0x is the simpler starting point; LI.FI is optional.</p></div></div>
      <label className="field">New 0x adapter<input value={saved.zeroX} onChange={e=>updateAddress('zeroX',e.target.value)} placeholder="0x…"/></label>
      <div className="verifyMeta"><span>{status.zeroXOk?'Verified router binding and release ID':'Not verified'}</span><span>Bytecode: {short(adaptiveBuyZeroXCodeHash)}</span></div>
      <button className="secondary" disabled={!eligible||!status.routerOk||Boolean(saved.zeroX)||Boolean(saved.txs.zeroX)||!!busy||!wallet} style={{marginTop:10}} onClick={deployZero}>Deploy new 0x adapter</button>
      {status.zeroXOk&&<button className="ghost" disabled={!!busy} style={{marginTop:8}} onClick={()=>verifyOnBaseScan('zeroX')}>Verify 0x source on BaseScan {verifyState.zeroX?.status||''}</button>}
      <label className="field">New LI.FI adapter (optional)<input value={saved.lifi} onChange={e=>updateAddress('lifi',e.target.value)} placeholder="0x…"/></label>
      <div className="verifyMeta"><span>{status.lifiOk?'Verified router binding and release ID':'Not verified'}</span><span>Bytecode: {short(adaptiveBuyLifiCodeHash)}</span></div>
      <button className="ghost" disabled={!eligible||!status.routerOk||Boolean(saved.lifi)||Boolean(saved.txs.lifi)||!!busy||!wallet} style={{marginTop:10}} onClick={deployLifi}>Deploy new LI.FI adapter (optional)</button>
      {status.lifiOk&&<button className="ghost" disabled={!!busy} style={{marginTop:8}} onClick={()=>verifyOnBaseScan('lifi')}>Verify LI.FI source on BaseScan {verifyState.lifi?.status||''}</button>}
    </section>
    <section className="card"><div className="stepHead"><div className="stepNo">04</div><div><h2>Approve adapters</h2><p>New adapter approval is timelocked for six hours. Proposal and activation require separate confirmed owner transactions. Disabling is immediate.</p></div></div>
      {adapters.map(a=><div className="deploymentRecordRow" key={a.key}><div><span>{a.label}</span><strong>{a.address||'Not deployed'}</strong><small className={a.approved?'good':a.ok?'':'bad'}>{a.approved?'Approved on-chain':!a.ok?'Not verified':a.pending?`Proposed · activation ${new Date(a.pending*1000).toLocaleString()}`:'Not proposed'}</small></div>
        {a.approved?<button className="ghost compact" disabled={!eligible||!!busy} onClick={()=>disable(getAddress(a.address))}>Disable</button>:a.ok?<button className="secondary compact" disabled={!eligible||!!busy||(Boolean(a.pending)&&Date.now()<a.pending*1000)} onClick={()=>a.pending?activate(getAddress(a.address)):propose(getAddress(a.address))}>{a.pending?'Activate':'Propose'}</button>:null}
      </div>)}
    </section>
    <section className="card"><div className="stepHead"><div className="stepNo">05</div><div><h2>Transfer-tax token allowance (existing policy)</h2><p>Optional. The existing Transfer-Tax Policy already supports receive rates from 100% down to 80% per token transfer. Changes apply to every V3.3.8 vault using the token; they do not increase the vault's 1% deposit tolerance.</p></div></div>
      <label className="field">Exact ERC-20 token address<input value={taxAsset} onChange={e=>{setTaxAsset(e.target.value);setTaxOnchain(null);setAckTaxChange(false)}} placeholder="0x…"/></label>
      <button className="ghost" style={{marginTop:10}} disabled={!pc||!!busy||!isAddress(taxAsset)} onClick={readTokenPolicy}>Read token's current allowance (free)</button>
      {taxOnchain!==null&&<div className="notice">Current receive rate: <b>{(taxOnchain/100).toFixed(2)}%</b> · allowed expected transfer loss {(100-taxOnchain/100).toFixed(2)}% per transfer</div>}
      <label className="field">Proposed receive rate, basis points (8000–10000)<input inputMode="numeric" value={taxBps} onChange={e=>setTaxBps(e.target.value)}/></label>
      <p className="notice">Example: 9900 = 1% transfer loss, 9500 = 5%, 9000 = 10%. This is a policy hint, not slippage or a waiver. The vault still measures real balances and can reject deposits if configured expectations don't match token behavior.</p>
      <label className="check"><input type="checkbox" checked={ackTaxChange} onChange={e=>setAckTaxChange(e.target.checked)}/><span>I verified this token's actual transfer behavior and understand the change affects existing vaults, not just the new router.</span></label>
      <button className="secondary" disabled={!eligible||!ackTaxChange||!!busy||!wallet||taxOnchain===null} onClick={updatePolicy}>Update transfer-loss policy (owner transaction)</button>
    </section>
    <section className="card"><div className="stepHead"><div className="stepNo">06</div><div><h2>Configure LI.FI permissions (optional)</h2><p>Only whitelist infrastructure that you have verified independently. Do not guess target, spender, or function selector. A new LI.FI adapter starts in bootstrap mode. If finalized, this page automatically uses the six-hour propose/activate path for each new permission.</p></div></div>
      <label className="field">Verified LI.FI target<input value={target} onChange={e=>setTarget(e.target.value)} placeholder="0x…"/></label>
      <label className="field">Verified LI.FI spender<input value={spender} onChange={e=>setSpender(e.target.value)} placeholder="0x…"/></label>
      <label className="field">Verified 4-byte selector<input value={selector} onChange={e=>setSelector(e.target.value)} placeholder="0x12345678"/></label>
      <button className="ghost" style={{marginTop:12}} disabled={!eligible||!!busy||!status.lifiOk||!wallet} onClick={()=>allowLifi().catch(e=>setError(e?.message||String(e)))}>Apply next missing LI.FI permission</button>
      {lifiStatus&&<div className="notice">{lifiStatus}</div>}
    </section>
    <section className="card"><div className="stepHead"><div className="stepNo">07</div><div><h2>Check an existing vault (free)</h2><p>Verify the selected vault belongs to the pinned V3.3.8 Factory, its share token belongs to the vault and it keeps the original sell router. Read-only checks use no gas.</p></div></div>
      <label className="field">Vault address<input value={testVault} onChange={e=>{setTestVault(e.target.value);setVaultCheck('');setVaultVerified(false)}} placeholder="0x…"/></label>
      <button className="ghost" disabled={!pc||!!busy||!isAddress(testVault)} onClick={checkVaultCompatibility}>Check existing vault</button>
      {vaultCheck&&<div className={`notice ${vaultVerified?'success':'danger'}`}>{vaultCheck}</div>}
    </section>
    <section className="card"><div className="stepHead"><div className="stepNo">08</div><div><h2>Export app integration addresses</h2><p>There is no Factory attachment transaction: this router works through public vault.deposit() after checking Factory registration. Once deployed, approved and tested, Indexio must explicitly route Buy More Shares to the new address; seed and sell stay on the original router.</p></div></div>
      <div className={`notice ${readiness?'success':'danger'}`}>{readiness?'0x adapter and buy router are configured on-chain. Still requires functional/fork testing before public use.':'Not ready: deploy and verify router, then deploy, propose and activate at least the 0x adapter.'}</div>
      <pre className="adaptive-deployment-record">{record}</pre>
      <button className="primary" disabled={!saved.router} onClick={()=>copy(record)}>Copy deployment record</button>
      <button className="ghost" style={{marginTop:9}} disabled={!saved.router} onClick={()=>copy(JSON.stringify({version:'3.3.8-adaptive-buy',chainId:8453,factory:FACTORY,router:saved.router,zeroXAdapter:saved.zeroX||null,lifiAdapter:saved.lifi||null,readyForMainnet:false},null,2))}>Copy app integration JSON</button>
    </section>
    {message&&<div role="status" className="notice success">{message}</div>}
    {error&&<div role="alert" className="notice danger">{error}</div>}
    <footer>Candidate contract only. The hard 1% vault tolerance cannot be raised by an external router. Wider refund or quote limits increase trade risk; always enforce minimum shares and simulate the exact route. No part of the existing V3.3.8 suite is modified.</footer>
  </main>;
}
