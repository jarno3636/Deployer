'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { useAccount, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import {
  indexioV25ExecutionRouterSeed25Abi,
  indexioV25ExecutionRouterSeed25Bytecode,
  indexioV25AdapterAbi,
  indexioV25AdapterBytecode,
} from '../lib/indexio-v25.generated';

const OWNER = getAddress('0x3118FE32B27651734fe4D966D1bC240bE6e3139D');
const FACTORY = getAddress('0x924572eD91ECD386ae8e04BF9df0cae6f9D5A219');
const BASE_USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const OLD_EXECUTION_ROUTER = getAddress('0xb9b7EFF366FE846b195B1D15126218a11E337631');
const ROUTE_TARGET = getAddress('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE');
const ROUTE_SPENDER = ROUTE_TARGET;
const ROUTE_SELECTOR = '0x5fd9ae2e' as Hex;
const EXPLORER = 'https://base.blockscout.com';
const STORAGE_KEY = 'indexio:v25:seed25-execution-upgrade';

type VerifyState = 'idle'|'pending'|'verified'|'error';

const factoryAbi = parseAbi([
  'function owner() view returns (address)',
  'function bootstrapFinalized() view returns (bool)',
  'function isExecutionRouter(address) view returns (bool)',
  'function pendingExecutionRouterValidAt(address) view returns (uint256)',
  'function proposeExecutionRouter(address router)',
  'function activateExecutionRouter(address router)',
  'function setExecutionRouter(address router,bool approved)',
]);
const routerAdminAbi = parseAbi([
  'function owner() view returns (address)',
  'function factory() view returns (address)',
  'function settlementToken() view returns (address)',
  'function approvedAdapter(address) view returns (bool)',
  'function bootstrapFinalized() view returns (bool)',
  'function setAdapter(address,bool)',
  'function finalizeBootstrap()',
  'function MIN_GROSS_SEED_USD18() view returns (uint256)',
]);
const adapterAdminAbi = parseAbi([
  'function owner() view returns (address)',
  'function callerRouter() view returns (address)',
  'function allowedRoute(bytes32) view returns (bool)',
  'function bootstrapFinalized() view returns (bool)',
  'function setRoute(address,address,bytes4,bool)',
  'function finalizeBootstrap()',
]);

function explorerAddress(a:string){return `${EXPLORER}/address/${a}`;}
function explorerTx(h:string){return `${EXPLORER}/tx/${h}`;}
function fmtWait(ts:number,now:number){const s=Math.max(0,ts-now);const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;return `${h}h ${m}m ${sec}s`;}

export function IndexioExecution25Upgrade(){
  const {address,chainId,isConnected}=useAccount();
  const {connectors,connectAsync,reset}=useConnect();
  const {disconnect}=useDisconnect();
  const {switchChainAsync,isPending:switching}=useSwitchChain();
  const publicClient=usePublicClient({chainId:base.id});
  const {data:walletClient}=useWalletClient({chainId:base.id});
  const injected=useMemo(()=>connectors.find(x=>x.id==='injected'),[connectors]);

  const [router,setRouter]=useState<Address|null>(null);
  const [adapter,setAdapter]=useState<Address|null>(null);
  const [routerHash,setRouterHash]=useState<Hex|null>(null);
  const [adapterHash,setAdapterHash]=useState<Hex|null>(null);
  const [routerVerify,setRouterVerify]=useState<VerifyState>('idle');
  const [adapterVerify,setAdapterVerify]=useState<VerifyState>('idle');
  const [routerValidated,setRouterValidated]=useState(false);
  const [adapterValidated,setAdapterValidated]=useState(false);
  const [factoryOwner,setFactoryOwner]=useState<Address|null>(null);
  const [factoryFinalized,setFactoryFinalized]=useState(false);
  const [prepared,setPrepared]=useState(false);
  const [scheduledAt,setScheduledAt]=useState(0);
  const [newActive,setNewActive]=useState(false);
  const [oldActive,setOldActive]=useState(false);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [now,setNow]=useState(()=>Math.floor(Date.now()/1000));
  const [mainnetAccepted,setMainnetAccepted]=useState(false);

  const onBase=chainId===base.id;
  const ownerConnected=!!address&&address.toLowerCase()===OWNER.toLowerCase();
  const routeKey=useMemo(()=>keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'bytes4'}],[ROUTE_TARGET,ROUTE_SPENDER,ROUTE_SELECTOR])),[]);

  useEffect(()=>{const t=setInterval(()=>setNow(Math.floor(Date.now()/1000)),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{try{const raw=localStorage.getItem(STORAGE_KEY);if(!raw)return;const s=JSON.parse(raw);if(s.router&&isAddress(s.router))setRouter(getAddress(s.router));if(s.adapter&&isAddress(s.adapter))setAdapter(getAddress(s.adapter));if(s.routerHash)setRouterHash(s.routerHash);if(s.adapterHash)setAdapterHash(s.adapterHash);if(s.routerVerify)setRouterVerify(s.routerVerify);if(s.adapterVerify)setAdapterVerify(s.adapterVerify);if(s.mainnetAccepted)setMainnetAccepted(true);}catch{}},[]);
  useEffect(()=>{try{localStorage.setItem(STORAGE_KEY,JSON.stringify({router,adapter,routerHash,adapterHash,routerVerify,adapterVerify,mainnetAccepted}));}catch{}},[router,adapter,routerHash,adapterHash,routerVerify,adapterVerify,mainnetAccepted]);

  function ready(){if(!isConnected||!address)throw new Error('Connect the protocol owner wallet first.');if(!onBase)throw new Error('Switch to Base mainnet.');if(!ownerConnected)throw new Error(`Connect the protocol owner ${OWNER}.`);if(!publicClient||!walletClient)throw new Error('Base wallet client is not ready.');if(!mainnetAccepted)throw new Error('Confirm the Base mainnet acknowledgement first.');}
  async function connectWallet(){setError(null);if(!injected)return setError('No injected wallet detected.');setBusy('connect');reset();try{await connectAsync({connector:injected,chainId:base.id});}catch(e){setError(e instanceof Error?e.message:'Wallet connection failed.');}finally{setBusy(null);}}
  async function read<T>(contract:Address,abi:any,functionName:string,args:readonly unknown[]=[]){if(!publicClient)throw new Error('Base client unavailable.');return await publicClient.readContract({address:contract,abi,functionName,args} as any) as T;}
  async function write(contract:Address,abi:any,functionName:string,args:readonly unknown[]=[]){ready();const data=encodeFunctionData({abi,functionName,args} as any);const hash=await walletClient!.sendTransaction({account:address!,chain:base,to:contract,data});const r=await publicClient!.waitForTransactionReceipt({hash});if(r.status!=='success')throw new Error(`${functionName} reverted.`);return hash;}

  async function refresh(){setError(null);setBusy('refresh');try{const [fo,ff,oa]=await Promise.all([read<Address>(FACTORY,factoryAbi,'owner'),read<boolean>(FACTORY,factoryAbi,'bootstrapFinalized'),read<boolean>(FACTORY,factoryAbi,'isExecutionRouter',[OLD_EXECUTION_ROUTER])]);setFactoryOwner(getAddress(fo));setFactoryFinalized(ff);setOldActive(oa);if(router){const code=await publicClient!.getBytecode({address:router});const [ro,active,pending,minSeed,factory,settlement,rf]=await Promise.all([read<Address>(router,routerAdminAbi,'owner'),read<boolean>(FACTORY,factoryAbi,'isExecutionRouter',[router]),read<bigint>(FACTORY,factoryAbi,'pendingExecutionRouterValidAt',[router]),read<bigint>(router,routerAdminAbi,'MIN_GROSS_SEED_USD18'),read<Address>(router,routerAdminAbi,'factory'),read<Address>(router,routerAdminAbi,'settlementToken'),read<boolean>(router,routerAdminAbi,'bootstrapFinalized')]);const routerOk=!!code&&code!=='0x'&&ro.toLowerCase()===OWNER.toLowerCase()&&minSeed===25n*10n**18n&&factory.toLowerCase()===FACTORY.toLowerCase()&&settlement.toLowerCase()===BASE_USDC.toLowerCase();if(!routerOk)throw new Error('Replacement router failed Base validation. Do not continue with this address.');setRouterValidated(true);setNewActive(active);setScheduledAt(Number(pending));if(adapter){const adapterCode=await publicClient!.getBytecode({address:adapter});const [ao,approved,caller,routeAllowed,af]=await Promise.all([read<Address>(adapter,adapterAdminAbi,'owner'),read<boolean>(router,routerAdminAbi,'approvedAdapter',[adapter]),read<Address>(adapter,adapterAdminAbi,'callerRouter'),read<boolean>(adapter,adapterAdminAbi,'allowedRoute',[routeKey]),read<boolean>(adapter,adapterAdminAbi,'bootstrapFinalized')]);const adapterOk=!!adapterCode&&adapterCode!=='0x'&&ao.toLowerCase()===OWNER.toLowerCase()&&caller.toLowerCase()===router.toLowerCase();setAdapterValidated(adapterOk);if(!adapterOk)throw new Error('Replacement adapter failed Base validation.');setPrepared(approved&&routeAllowed&&af&&rf);}else{setAdapterValidated(false);setPrepared(false);}}else{setRouterValidated(false);setAdapterValidated(false);}setNotice('Production state refreshed and deployment validated directly from Base.');}catch(e){setError(e instanceof Error?e.message:'Refresh failed.');}finally{setBusy(null);}}

  async function deployRouter(){setError(null);setBusy('deploy-router');try{ready();const data=encodeDeployData({abi:indexioV25ExecutionRouterSeed25Abi,bytecode:indexioV25ExecutionRouterSeed25Bytecode,args:[OWNER,FACTORY,BASE_USDC]});await publicClient!.estimateGas({account:address!,data});const hash=await walletClient!.deployContract({account:address!,chain:base,abi:indexioV25ExecutionRouterSeed25Abi,bytecode:indexioV25ExecutionRouterSeed25Bytecode,args:[OWNER,FACTORY,BASE_USDC]});setRouterHash(hash);const r=await publicClient!.waitForTransactionReceipt({hash});if(r.status!=='success'||!r.contractAddress)throw new Error('Router deployment failed.');const deployedRouter=getAddress(r.contractAddress);setRouter(deployedRouter);setRouterVerify('idle');setRouterValidated(true);setNotice('New $25 Execution Router deployed and confirmed on Base. Blockscout verification is optional and can be retried later.');}catch(e){setError(e instanceof Error?e.message:'Router deployment failed.');}finally{setBusy(null);}}
  async function deployAdapter(){setError(null);setBusy('deploy-adapter');try{ready();if(!router)throw new Error('Deploy the replacement router first.');const data=encodeDeployData({abi:indexioV25AdapterAbi,bytecode:indexioV25AdapterBytecode,args:[OWNER,router]});await publicClient!.estimateGas({account:address!,data});const hash=await walletClient!.deployContract({account:address!,chain:base,abi:indexioV25AdapterAbi,bytecode:indexioV25AdapterBytecode,args:[OWNER,router]});setAdapterHash(hash);const r=await publicClient!.waitForTransactionReceipt({hash});if(r.status!=='success'||!r.contractAddress)throw new Error('Adapter deployment failed.');const deployedAdapter=getAddress(r.contractAddress);setAdapter(deployedAdapter);setAdapterVerify('idle');setAdapterValidated(true);setNotice('Router-bound Execution Adapter deployed. Verify it next.');}catch(e){setError(e instanceof Error?e.message:'Adapter deployment failed.');}finally{setBusy(null);}}
  function ctorArgs(values:Address[]){return encodeAbiParameters(values.map(()=>({type:'address'})) as any,values as any);}
  async function verify(kind:'router'|'adapter'){setError(null);setBusy(`verify-${kind}`);try{const a=kind==='router'?router:adapter;if(!a)throw new Error('Deploy this contract first.');const constructorArguments=kind==='router'?ctorArgs([OWNER,FACTORY,BASE_USDC]):ctorArgs([OWNER,router!]);const r=await fetch('/api/blockscout/verify-indexio-v25',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:kind==='router'?'executionRouterSeed25':'adapter',address:a,constructorArguments})});const j=await r.json();if(!r.ok)throw new Error(j.error||'Verification failed.');const state=j.verified?'verified':'pending';kind==='router'?setRouterVerify(state):setAdapterVerify(state);setNotice(j.message||'Verification submitted.');}catch(e){kind==='router'?setRouterVerify('error'):setAdapterVerify('error');setError(e instanceof Error?e.message:'Verification failed.');}finally{setBusy(null);}}

  async function prepare(){setError(null);setBusy('prepare');try{ready();if(!router||!adapter)throw new Error('Deploy the replacement router and adapter first.');if(!routerValidated||!adapterValidated)throw new Error('Validate both new contracts on Base before preparing them.');let [routeAllowed,adapterApproved,af,rf]=await Promise.all([read<boolean>(adapter,adapterAdminAbi,'allowedRoute',[routeKey]),read<boolean>(router,routerAdminAbi,'approvedAdapter',[adapter]),read<boolean>(adapter,adapterAdminAbi,'bootstrapFinalized'),read<boolean>(router,routerAdminAbi,'bootstrapFinalized')]);if(!routeAllowed){setNotice('1/4 — Approve the reviewed LI.FI route on the new adapter.');await write(adapter,adapterAdminAbi,'setRoute',[ROUTE_TARGET,ROUTE_SPENDER,ROUTE_SELECTOR,true]);routeAllowed=true;}if(!adapterApproved){setNotice('2/4 — Approve the new adapter on the replacement router.');await write(router,routerAdminAbi,'setAdapter',[adapter,true]);adapterApproved=true;}if(!af){setNotice('3/4 — Finalize the new adapter bootstrap.');await write(adapter,adapterAdminAbi,'finalizeBootstrap');af=true;}if(!rf){setNotice('4/4 — Finalize the replacement router bootstrap.');await write(router,routerAdminAbi,'finalizeBootstrap');rf=true;}setPrepared(routeAllowed&&adapterApproved&&af&&rf);setNotice('Replacement router + adapter prepared and permanently finalized. Ready to schedule with the Factory.');}catch(e){setError(e instanceof Error?e.message:'Preparation stopped safely. Re-run it; completed steps will be skipped.');}finally{setBusy(null);}}

  async function schedule(){setError(null);setBusy('schedule');try{ready();if(!router||!prepared)throw new Error('Prepare the replacement router first.');const active=await read<boolean>(FACTORY,factoryAbi,'isExecutionRouter',[router]);if(active){setNewActive(true);setNotice('Replacement router is already active.');return;}let pending=await read<bigint>(FACTORY,factoryAbi,'pendingExecutionRouterValidAt',[router]);if(pending===0n){await write(FACTORY,factoryAbi,'proposeExecutionRouter',[router]);pending=await read<bigint>(FACTORY,factoryAbi,'pendingExecutionRouterValidAt',[router]);}setScheduledAt(Number(pending));setNotice(`Factory activation scheduled. The 24-hour delay ends at ${new Date(Number(pending)*1000).toLocaleString()}.`);}catch(e){setError(e instanceof Error?e.message:'Scheduling failed.');}finally{setBusy(null);}}
  async function activate(){setError(null);setBusy('activate');try{ready();if(!router)throw new Error('Replacement router missing.');const pending=await read<bigint>(FACTORY,factoryAbi,'pendingExecutionRouterValidAt',[router]);if(pending===0n){const active=await read<boolean>(FACTORY,factoryAbi,'isExecutionRouter',[router]);if(active){setNewActive(true);setNotice('Replacement router is already active.');return;}throw new Error('No pending Factory activation found. Schedule it first.');}if(BigInt(Math.floor(Date.now()/1000))<pending)throw new Error(`24-hour timelock is still running. Ready ${new Date(Number(pending)*1000).toLocaleString()}.`);await write(FACTORY,factoryAbi,'activateExecutionRouter',[router]);setNewActive(true);setScheduledAt(0);setNotice('New $25 Execution Router is active on the Factory. Update the Indexio app to use this address before disabling the old router.');}catch(e){setError(e instanceof Error?e.message:'Activation failed.');}finally{setBusy(null);}}
  async function disableOld(){setError(null);setBusy('disable-old');try{ready();if(!newActive)throw new Error('Activate the new router first.');await write(FACTORY,factoryAbi,'setExecutionRouter',[OLD_EXECUTION_ROUTER,false]);setOldActive(false);setNotice('Old $100 Execution Router disabled immediately. The Factory now accepts the new $25 router.');}catch(e){setError(e instanceof Error?e.message:'Old-router disable failed.');}finally{setBusy(null);}}
  async function copyRecord(){if(!router||!adapter)return;const txt=`INDEXIO V2.5 EXECUTION ROUTER UPGRADE — BASE MAINNET\nMinimum initial seed: 25 USDC\nFactory: ${FACTORY}\nUSDC: ${BASE_USDC}\nProtocol Owner: ${OWNER}\nNew Execution Router: ${router}\nNew Execution Adapter: ${adapter}\nReviewed route target: ${ROUTE_TARGET}\nReviewed route spender: ${ROUTE_SPENDER}\nReviewed route selector: ${ROUTE_SELECTOR}\nNew router active: ${newActive}\nOld $100 router active: ${oldActive}`;try{await navigator.clipboard.writeText(txt);setNotice('Upgrade record copied.');}catch{setNotice(txt);}}

  const readyAt=scheduledAt?new Date(scheduledAt*1000):null;
  const canActivate=scheduledAt>0&&now>=scheduledAt;

  return <main className="shell">
    <section className="hero"><div className="brandRow"><div className="mark">I</div><div><div className="eyebrow">INDEXIO V2.5</div><div className="networkPill"><i/>Execution Router upgrade</div></div></div><h1>Lower initial seed to $25.</h1><p>This guided flow changes only the Execution Router path. The finalized Factory, Vault Deployer, Asset Registry, Rebalance Router, Reinvestment Router, vaults, and fee treasury stay in place.</p></section>

    <section className="card"><div className="stepHead"><div className="stepNo">01</div><div><h2>Connect protocol owner</h2><p>Only the current Factory owner can schedule and activate a new Execution Router.</p></div></div>{!isConnected?<button className="primary" onClick={connectWallet}>Connect wallet</button>:<div className="walletBox"><div><span>CONNECTED</span><b>{address}</b></div><button className="ghost compact" onClick={()=>disconnect()}>Disconnect</button></div>}{isConnected&&!onBase&&<button className="secondary" onClick={()=>switchChainAsync({chainId:base.id})} disabled={switching}>Switch to Base</button>}<div className="details"><div><span>Protocol owner</span><strong>{OWNER}</strong></div><div><span>Factory</span><strong>{FACTORY}</strong></div><div><span>Current router</span><strong>{OLD_EXECUTION_ROUTER}</strong></div></div><label className="check"><input type="checkbox" checked={mainnetAccepted} onChange={e=>setMainnetAccepted(e.target.checked)}/><span>I understand these are Base mainnet transactions. The existing V2.5 stack is not being redeployed.</span></label><button className="ghost" onClick={refresh} disabled={!!busy}>{busy==='refresh'?'Reading Base…':'Check production state'}</button>{factoryOwner&&<div className="notice"><b>Factory</b><p>Owner: {factoryOwner}<br/>Bootstrap: {factoryFinalized?'FINALIZED':'OPEN'}<br/>Old $100 router: {oldActive?'ACTIVE':'DISABLED'}</p></div>}</section>

    <section className="card"><div className="stepHead"><div className="stepNo">02</div><div><h2>Deploy $25 Execution Router</h2><p>Same V2.5 execution logic and 5% hard slippage ceiling; only the minimum initial seed changes from $100 to $25.</p></div></div>{router?<><div className="contractBox"><span>NEW EXECUTION ROUTER</span><strong>{router}</strong></div>{routerHash&&<a className="linkButton" href={explorerTx(routerHash)} target="_blank">View deployment transaction</a>}<a className="linkButton" href={explorerAddress(router)} target="_blank">Open on Blockscout</a><div className="notice success"><b>{routerValidated?'Validated on Base ✓':'Validation required'}</b><p>Checks bytecode, owner, Factory, USDC and the 25 USDC minimum directly onchain.</p></div><button className="ghost" onClick={refresh} disabled={!!busy}>{routerValidated?'Recheck Base validation':'Validate router on Base'}</button><button className="secondary" onClick={()=>verify('router')} disabled={!!busy||routerVerify==='verified'}>{routerVerify==='verified'?'Blockscout verified ✓':routerVerify==='pending'?'Retry Blockscout verification':'Verify source on Blockscout (optional)'}</button></>:<button className="primary deploy" onClick={deployRouter} disabled={!!busy||!ownerConnected||!mainnetAccepted}>Deploy $25 Execution Router</button>}</section>

    <section className="card"><div className="stepHead"><div className="stepNo">03</div><div><h2>Deploy its dedicated adapter</h2><p>The existing Execution Adapter cannot be reused because every adapter is permanently bound to its caller router.</p></div></div>{adapter?<><div className="contractBox"><span>NEW EXECUTION ADAPTER</span><strong>{adapter}</strong></div>{adapterHash&&<a className="linkButton" href={explorerTx(adapterHash)} target="_blank">View deployment transaction</a>}<a className="linkButton" href={explorerAddress(adapter)} target="_blank">Open on Blockscout</a><div className="notice success"><b>{adapterValidated?'Validated on Base ✓':'Validation required'}</b><p>Checks bytecode, owner and immutable caller-router binding directly onchain.</p></div><button className="ghost" onClick={refresh} disabled={!!busy}>{adapterValidated?'Recheck Base validation':'Validate adapter on Base'}</button><button className="secondary" onClick={()=>verify('adapter')} disabled={!!busy||adapterVerify==='verified'}>{adapterVerify==='verified'?'Blockscout verified ✓':adapterVerify==='pending'?'Retry Blockscout verification':'Verify source on Blockscout (optional)'}</button></>:<button className="primary deploy" onClick={deployAdapter} disabled={!!busy||!router||!routerValidated}>Deploy matching Execution Adapter</button>}</section>

    <section className="card"><div className="stepHead"><div className="stepNo">04</div><div><h2>Prepare replacement</h2><p>One resumable setup button approves the reviewed LI.FI route, attaches the adapter, then irreversibly finalizes both new contracts.</p></div></div><div className="details"><div><span>Target</span><strong>{ROUTE_TARGET}</strong></div><div><span>Spender</span><strong>{ROUTE_SPENDER}</strong></div><div><span>Selector</span><strong>{ROUTE_SELECTOR}</strong></div></div><button className="primary" onClick={prepare} disabled={!!busy||!router||!adapter||!routerValidated||!adapterValidated||prepared}>{prepared?'Replacement prepared ✓':busy==='prepare'?'Preparing missing steps…':'Prepare router + adapter'}</button><div className="notice"><b>Resumable.</b><p>If your wallet closes between confirmations, run this step again. It reads Base and skips already-completed setup calls.</p></div></section>

    <section className="card"><div className="stepHead"><div className="stepNo">05</div><div><h2>Schedule Factory activation</h2><p>Because the Factory bootstrap is finalized, adding this router correctly requires the existing 24-hour governance delay.</p></div></div><button className="secondary" onClick={schedule} disabled={!!busy||!prepared||newActive||scheduledAt>0}>{newActive?'Already active ✓':scheduledAt>0?'Scheduled ✓':'Schedule 24-hour activation'}</button>{scheduledAt>0&&!newActive&&<div className="notice"><b>Timelock running</b><p>Ready: {readyAt?.toLocaleString()}<br/>Remaining: {fmtWait(scheduledAt,now)}</p></div>}</section>

    <section className="card"><div className="stepHead"><div className="stepNo">06</div><div><h2>Activate after 24 hours</h2><p>This is the transaction that makes the new router an approved Factory execution path.</p></div></div><button className="primary" onClick={activate} disabled={!!busy||newActive||!canActivate}>{newActive?'New $25 router active ✓':scheduledAt===0?'Schedule first':canActivate?'Activate $25 Execution Router':`Waiting ${fmtWait(scheduledAt,now)}`}</button>{newActive&&router&&<div className="notice success"><b>Factory approved ✓</b><p>New Execution Router: {router}</p></div>}</section>

    <section className="card"><div className="stepHead"><div className="stepNo">07</div><div><h2>Cut over safely</h2><p>First update the Indexio app to the new router address and test a $25+ seed. Only then disable the old $100 router.</p></div></div><button className="ghost" onClick={disableOld} disabled={!!busy||!newActive||!oldActive}>{oldActive?'Disable old $100 router':'Old router disabled ✓'}</button><button className="primary" onClick={copyRecord} disabled={!router||!adapter}>Copy upgrade record</button><div className="notice"><b>Important.</b><p>Do not disable the old router until the production app is pointing at the new address and a live smoke test succeeds. Both routers can remain approved during the cutover window.</p></div></section>

    {notice&&<div className="notice success strong">{notice}</div>}{error&&<div className="card error"><b>Action stopped safely</b><p>{error}</p></div>}
    <footer>Factory: {FACTORY}. Base USDC: {BASE_USDC}. New minimum: 25 USDC. Existing 1% Indexio entry/exit fee remains unchanged.</footer>
  </main>;
}
