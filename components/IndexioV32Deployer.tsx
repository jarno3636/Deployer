'use client';
import {useEffect,useMemo,useState} from 'react';
import {useAccount,useConnect,usePublicClient,useWalletClient} from 'wagmi';
import {injected} from 'wagmi/connectors';
import {base} from 'wagmi/chains';
import {Address,getAddress,isAddress} from 'viem';
import {
 indexioV3SafetyControllerAbi,indexioV3SafetyControllerBytecode,
 indexioV3VaultDeployerAbi,indexioV3VaultDeployerBytecode,
 indexioV3FactoryAbi,indexioV3FactoryBytecode,
 indexioV3ExecutionRouterAbi,indexioV3ExecutionRouterBytecode,
 indexioV3RestrictedSwapAdapterAbi,indexioV3RestrictedSwapAdapterBytecode,
 indexioV3LifiSwapAdapterAbi,indexioV3LifiSwapAdapterBytecode,
 indexioV3VaultCreationCodeHash,indexioV3VaultCreationCodeLength
} from '../lib/indexio-v3.generated';

const REGISTRY=getAddress('0x5C4791e3B752d9b084E8FD76932E82C2031f15c1');
const USDC=getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const KEY='indexio-v3-2-0-deployment-base';
const SAFETY_FACTORY_ABI=[{type:'function',name:'factory',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},{type:'function',name:'factoryLocked',stateMutability:'view',inputs:[],outputs:[{type:'bool'}]},{type:'function',name:'setFactoryOnce',stateMutability:'nonpayable',inputs:[{name:'f',type:'address'}],outputs:[]}] as const;
const DEPLOYER_FACTORY_ABI=[{type:'function',name:'canonicalFactory',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},{type:'function',name:'factoryLocked',stateMutability:'view',inputs:[],outputs:[{type:'bool'}]},{type:'function',name:'setFactoryOnce',stateMutability:'nonpayable',inputs:[{name:'factory',type:'address'}],outputs:[]}] as const;
const FACTORY_ROUTER_ABI=[{type:'function',name:'executionRouter',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},{type:'function',name:'executionRouterLocked',stateMutability:'view',inputs:[],outputs:[{type:'bool'}]},{type:'function',name:'setExecutionRouterOnce',stateMutability:'nonpayable',inputs:[{name:'router',type:'address'}],outputs:[]}] as const;
const ROUTER_ADMIN_ABI=[
 {type:'function',name:'setAdapter',stateMutability:'nonpayable',inputs:[{name:'adapter',type:'address'},{name:'approved',type:'bool'}],outputs:[]},
 {type:'function',name:'approvedAdapter',stateMutability:'view',inputs:[{name:'adapter',type:'address'}],outputs:[{type:'bool'}]},
 {type:'function',name:'proposeAdapter',stateMutability:'nonpayable',inputs:[{name:'adapter',type:'address'}],outputs:[]},
 {type:'function',name:'activateAdapter',stateMutability:'nonpayable',inputs:[{name:'adapter',type:'address'}],outputs:[]},
 {type:'function',name:'pendingAdapterValidAt',stateMutability:'view',inputs:[{name:'adapter',type:'address'}],outputs:[{type:'uint256'}]},
] as const;
const LIFI_ADMIN_ABI=[
 {type:'function',name:'allowedRoute',stateMutability:'view',inputs:[{name:'key',type:'bytes32'}],outputs:[{type:'bool'}]},
 {type:'function',name:'routeKey',stateMutability:'pure',inputs:[{name:'target',type:'address'},{name:'spender',type:'address'},{name:'selector',type:'bytes4'}],outputs:[{type:'bytes32'}]},
 {type:'function',name:'setRoute',stateMutability:'nonpayable',inputs:[{name:'target',type:'address'},{name:'spender',type:'address'},{name:'selector',type:'bytes4'},{name:'allowed',type:'bool'}],outputs:[]},
 {type:'function',name:'finalizeBootstrap',stateMutability:'nonpayable',inputs:[],outputs:[]},
 {type:'function',name:'bootstrapFinalized',stateMutability:'view',inputs:[],outputs:[{type:'bool'}]},
] as const;

type Kind='safetyController'|'vaultDeployer'|'factory'|'executionRouter'|'zeroXAdapter'|'lifiAdapter';
type State=Partial<Record<Kind,Address>>;
type Route={target:Address;spender:Address;selector:`0x${string}`;tool:string;coverage:number;samples:string[]};
const ORDER:Kind[]=['safetyController','vaultDeployer','factory','executionRouter','zeroXAdapter','lifiAdapter'];
const LABEL:Record<Kind,string>={safetyController:'Emergency Safety Controller',vaultDeployer:'Permissionless Vault Deployer',factory:'Indexio V3.2 Factory',executionRouter:'Execution Router',zeroXAdapter:'0x Adapter',lifiAdapter:'LI.FI Restricted Adapter'};

export function IndexioV32Deployer(){
 const {address,isConnected}=useAccount();const {connectAsync}=useConnect();const pc=usePublicClient({chainId:base.id});const {data:wc}=useWalletClient({chainId:base.id});
 const [owner,setOwner]=useState('');const [treasury,setTreasury]=useState('');const [a,setA]=useState<State>({});const [busy,setBusy]=useState('');const [msg,setMsg]=useState('');const [err,setErr]=useState('');const [routes,setRoutes]=useState<Route[]>([]);
 useEffect(()=>{try{const x=localStorage.getItem(KEY);if(x)setA(JSON.parse(x));}catch{}},[]);useEffect(()=>{localStorage.setItem(KEY,JSON.stringify(a));},[a]);useEffect(()=>{if(address&&!owner)setOwner(address)},[address,owner]);
 const ownerAddr=useMemo(()=>isAddress(owner)?getAddress(owner):null,[owner]);const treasuryAddr=useMemo(()=>isAddress(treasury)?getAddress(treasury):null,[treasury]);
 async function tx(address:Address,abi:any,functionName:string,args:any[]=[]){if(!wc||!pc)throw Error('Connect wallet on Base.');const hash=await (wc.writeContract as any)({address,abi,functionName,args,account:wc.account});const r=await pc.waitForTransactionReceipt({hash});if(r.status!=='success')throw Error(`${functionName} reverted.`);return hash;}
 function artifact(k:Kind){if(!ownerAddr)throw Error('Enter protocol owner.');if(k==='safetyController')return{abi:indexioV3SafetyControllerAbi,bytecode:indexioV3SafetyControllerBytecode,args:[ownerAddr]};if(k==='vaultDeployer')return{abi:indexioV3VaultDeployerAbi,bytecode:indexioV3VaultDeployerBytecode,args:[ownerAddr,indexioV3VaultCreationCodeHash,indexioV3VaultCreationCodeLength]};if(k==='factory'){if(!treasuryAddr||!a.safetyController||!a.vaultDeployer)throw Error('Treasury, Safety and Vault Deployer required.');return{abi:indexioV3FactoryAbi,bytecode:indexioV3FactoryBytecode,args:[ownerAddr,REGISTRY,USDC,treasuryAddr,a.safetyController,a.vaultDeployer]};}if(k==='executionRouter'){if(!a.factory)throw Error('Factory required.');return{abi:indexioV3ExecutionRouterAbi,bytecode:indexioV3ExecutionRouterBytecode,args:[ownerAddr,a.factory]};}if(!a.executionRouter)throw Error('Execution Router required.');if(k==='zeroXAdapter')return{abi:indexioV3RestrictedSwapAdapterAbi,bytecode:indexioV3RestrictedSwapAdapterBytecode,args:[a.executionRouter]};return{abi:indexioV3LifiSwapAdapterAbi,bytecode:indexioV3LifiSwapAdapterBytecode,args:[ownerAddr,a.executionRouter]};}
 async function deploy(k:Kind){setBusy(k);setErr('');setMsg('');try{if(!wc||!pc)throw Error('Connect wallet on Base.');const x=artifact(k);const hash=await wc.deployContract({abi:x.abi as any,bytecode:x.bytecode,args:x.args as any,account:wc.account});const r=await pc.waitForTransactionReceipt({hash});if(r.status!=='success'||!r.contractAddress)throw Error(`${LABEL[k]} deployment failed.`);const addr=getAddress(r.contractAddress);const code=await pc.getBytecode({address:addr});if(!code||code==='0x')throw Error('No deployed bytecode found.');setA(v=>({...v,[k]:addr}));setMsg(`${LABEL[k]} deployed and confirmed: ${addr}`);}catch(e:any){setErr(e?.shortMessage||e?.message||String(e))}finally{setBusy('')}}
 async function discover(){if(!address||!a.lifiAdapter)return;setBusy('discover');setErr('');try{const r=await fetch('/api/lifi/discover-routes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fromAddress:a.lifiAdapter})});const j=await r.json();if(!r.ok)throw Error(j?.error||'LI.FI discovery failed.');setRoutes(j.routes||[]);setMsg(`${(j.routes||[]).length} trusted LI.FI route permissions discovered across ${j.assetsQuoted||0} assets.`)}catch(e:any){setErr(e?.message||String(e))}finally{setBusy('')}}
 async function approveRoutes(){if(!a.lifiAdapter||!pc)return;setBusy('routes');setErr('');try{for(const r of routes){const key=await pc.readContract({address:a.lifiAdapter,abi:LIFI_ADMIN_ABI,functionName:'routeKey',args:[r.target,r.spender,r.selector]});const ok=await pc.readContract({address:a.lifiAdapter,abi:LIFI_ADMIN_ABI,functionName:'allowedRoute',args:[key]});if(!ok)await tx(a.lifiAdapter,LIFI_ADMIN_ABI,'setRoute',[r.target,r.spender,r.selector,true]);}setMsg('All discovered LI.FI route permissions are approved.')}catch(e:any){setErr(e?.shortMessage||e?.message||String(e))}finally{setBusy('')}}
 async function finalWire(){if(!a.safetyController||!a.vaultDeployer||!a.factory||!a.executionRouter||!a.zeroXAdapter||!a.lifiAdapter) return;setBusy('wire');setErr('');try{
  const sf=await pc!.readContract({address:a.safetyController,abi:SAFETY_FACTORY_ABI,functionName:'factoryLocked'});if(!sf)await tx(a.safetyController,SAFETY_FACTORY_ABI,'setFactoryOnce',[a.factory]);
  const df=await pc!.readContract({address:a.vaultDeployer,abi:DEPLOYER_FACTORY_ABI,functionName:'factoryLocked'});if(!df)await tx(a.vaultDeployer,DEPLOYER_FACTORY_ABI,'setFactoryOnce',[a.factory]);
  const z=await pc!.readContract({address:a.executionRouter,abi:ROUTER_ADMIN_ABI,functionName:'approvedAdapter',args:[a.zeroXAdapter]});if(!z)await tx(a.executionRouter,ROUTER_ADMIN_ABI,'setAdapter',[a.zeroXAdapter,true]);
  const l=await pc!.readContract({address:a.executionRouter,abi:ROUTER_ADMIN_ABI,functionName:'approvedAdapter',args:[a.lifiAdapter]});if(!l)await tx(a.executionRouter,ROUTER_ADMIN_ABI,'setAdapter',[a.lifiAdapter,true]);
  const fin=await pc!.readContract({address:a.lifiAdapter,abi:LIFI_ADMIN_ABI,functionName:'bootstrapFinalized'});if(!fin)await tx(a.lifiAdapter,LIFI_ADMIN_ABI,'finalizeBootstrap',[]);
  const locked=await pc!.readContract({address:a.factory,abi:FACTORY_ROUTER_ABI,functionName:'executionRouterLocked'});if(!locked)await tx(a.factory,FACTORY_ROUTER_ABI,'setExecutionRouterOnce',[a.executionRouter]);
  setMsg('V3.2 wiring complete. Both 0x and LI.FI adapters are active. Future adapter additions use the 6-hour safety delay; emergency disables remain immediate.');
 }catch(e:any){setErr(e?.shortMessage||e?.message||String(e))}finally{setBusy('')}}
 const ready=ORDER.every(k=>a[k]);
 return <main className="deployerShell"><header><p className="eyebrow">INDEXIO · BASE · V3.2.0</p><h1>V3.2 Guided Deployer</h1><p>Dual-route execution: LI.FI for B20/tokenized-stock routes and 0x as an approved secondary adapter. Deploy, discover routes, review, then wire once.</p></header>
 {!isConnected?<button className="primary" onClick={()=>connectAsync({connector:injected(),chainId:base.id})}>Connect deployment wallet</button>:null}
 <section className="card"><h2>Deployment settings</h2><label>Protocol owner / guardian<input value={owner} onChange={e=>setOwner(e.target.value)} placeholder="0x…"/></label><label>Indexio fee treasury (mandatory 1%)<input value={treasury} onChange={e=>setTreasury(e.target.value)} placeholder="0x…"/></label><div className="contractBox"><span>REUSED ASSET REGISTRY</span><strong>{REGISTRY}</strong></div><div className="contractBox"><span>BASE USDC</span><strong>{USDC}</strong></div></section>
 {ORDER.map((k,i)=><section className="card" key={k}><div className="stepHead"><div className="stepNo">{String(i+1).padStart(2,'0')}</div><div><h2>{LABEL[k]}</h2><p>{a[k]||'Ready for deployment'}</p></div></div>{a[k]?<div className="contractBox"><span>ONCHAIN ADDRESS</span><strong>{a[k]}</strong></div>:<button className="primary" disabled={!!busy||(i>0&&!a[ORDER[i-1]])} onClick={()=>deploy(k)}>{busy===k?'Deploying…':`Deploy ${LABEL[k]}`}</button>}</section>)}
 <section className="card"><div className="stepHead"><div className="stepNo">07</div><div><h2>Discover LI.FI stock routes</h2><p>Reads the existing Asset Registry, requests live Base LI.FI routes in both directions, and keeps only tuples backed by LI.FI's official Base deployment/allowlist metadata.</p></div></div><button className="primary" disabled={!a.lifiAdapter||!!busy} onClick={discover}>{busy==='discover'?'Discovering…':'Discover trusted LI.FI routes'}</button>{routes.length>0?<><div className="notice"><b>{routes.length} trusted route permissions found</b>{routes.map((r,i)=><p key={`${r.target}-${r.spender}-${r.selector}`}>{i+1}. {r.tool} · {r.selector} · coverage {r.coverage}<br/>{r.target}<br/>{r.spender}</p>)}</div><button className="primary" disabled={!!busy} onClick={approveRoutes}>{busy==='routes'?'Approving…':'Approve discovered LI.FI routes'}</button></>:null}</section>
 <section className="card"><div className="stepHead"><div className="stepNo">08</div><div><h2>Final wiring</h2><p>Run only after the contracts and LI.FI route list are reviewed. This binds the canonical router but no longer freezes Indexio to today's adapters.</p></div></div><button className="primary" disabled={!ready||routes.length===0||!!busy} onClick={finalWire}>{busy==='wire'?'Wiring + confirming…':'Wire V3.2 protocol'}</button><div className="notice"><b>Post-launch adapter safety</b><p>New adapters can be proposed after launch and become activatable after 6 hours. Any approved adapter can still be disabled immediately. The canonical Execution Router itself remains permanently bound to the Factory.</p></div></section>
 {msg&&<div className="notice">{msg}</div>}{err&&<div className="errorBox">{err}</div>}
 </main>;
}
