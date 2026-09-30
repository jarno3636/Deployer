'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { useAccount, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import {
  indexioV25VaultDeployerAbi,
  indexioV25VaultDeployerBytecode,
  indexioV25FactoryAbi,
  indexioV25FactoryBytecode,
  indexioV25ExecutionRouterAbi,
  indexioV25ExecutionRouterBytecode,
  indexioV25RebalanceRouterAbi,
  indexioV25RebalanceRouterBytecode,
  indexioV25ReinvestmentRouterAbi,
  indexioV25ReinvestmentRouterBytecode,
  indexioV25AdapterAbi,
  indexioV25AdapterBytecode,
} from '../lib/indexio-v25.generated';

const BASE_USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const EXISTING_ASSET_REGISTRY = getAddress('0x5C4791e3B752d9b084E8FD76932E82C2031f15c1');
const EXPLORER = 'https://base.blockscout.com';
const STORAGE_KEY = 'indexio-v2.5:base-mainnet:deployment';

type Kind = 'vaultDeployer' | 'factory' | 'executionRouter' | 'rebalanceRouter' | 'reinvestmentRouter' | 'executionAdapter' | 'rebalanceAdapter' | 'reinvestmentAdapter';
type VerifyState = 'idle' | 'pending' | 'verified' | 'error';
type State = Partial<Record<Kind, Address>>;
type Hashes = Partial<Record<Kind, Hex>>;

const ORDER: Kind[] = ['vaultDeployer','factory','executionRouter','rebalanceRouter','reinvestmentRouter','executionAdapter','rebalanceAdapter','reinvestmentAdapter'];
const LABEL: Record<Kind,string> = {
  vaultDeployer:'Vault Deployer', factory:'Factory', executionRouter:'Execution Router', rebalanceRouter:'Rebalance Router', reinvestmentRouter:'Reinvestment Router', executionAdapter:'Execution Adapter', rebalanceAdapter:'Rebalance Adapter', reinvestmentAdapter:'Reinvestment Adapter',
};
const factoryAdminAbi = parseAbi([
  'function setExecutionRouter(address router,bool approved)',
  'function setRebalanceRouter(address router,bool approved)',
  'function setReinvestmentRouter(address router,bool approved)',
  'function setDefaultReinvestmentRouter(address router)',
  'function isExecutionRouter(address) view returns (bool)',
  'function isRebalanceRouter(address) view returns (bool)',
  'function isReinvestmentRouter(address) view returns (bool)',
  'function defaultReinvestmentRouter() view returns (address)',
  'function bootstrapFinalized() view returns (bool)',
  'function finalizeBootstrap()',
]);
const routerAdminAbi = parseAbi([
  'function setAdapter(address adapter,bool approved)',
  'function approvedAdapter(address) view returns (bool)',
  'function bootstrapFinalized() view returns (bool)',
  'function finalizeBootstrap()',
]);
const adapterAdminAbi = parseAbi([
  'function setRoute(address target,address spender,bytes4 selector,bool allowed)',
  'function allowedRoute(bytes32) view returns (bool)',
  'function bootstrapFinalized() view returns (bool)',
  'function finalizeBootstrap()',
]);
const assetRegistryReadAbi = parseAbi([
  'function config(address asset) view returns (bool enabled,uint16 maxWeightBps,uint8 decimals)',
]);

function explorerAddress(a: string) { return `${EXPLORER}/address/${a}`; }
function explorerTx(h: string) { return `${EXPLORER}/tx/${h}`; }

export function IndexioV25Deployer() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: base.id });
  const { data: walletClient } = useWalletClient({ chainId: base.id });
  const injected = useMemo(() => connectors.find((x) => x.id === 'injected'), [connectors]);

  const [ownerInput,setOwnerInput] = useState('');
  const [treasuryInput,setTreasuryInput] = useState('');
  const [addresses,setAddresses] = useState<State>({});
  const [hashes,setHashes] = useState<Hashes>({});
  const [verified,setVerified] = useState<Partial<Record<Kind,VerifyState>>>({});
  const [verifyMessage,setVerifyMessage] = useState<Partial<Record<Kind,string>>>({});
  const [registryReady,setRegistryReady] = useState(false);
  const [busy,setBusy] = useState<string|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [notice,setNotice] = useState<string|null>(null);
  const [mainnetAccepted,setMainnetAccepted] = useState(false);
  const [wired,setWired] = useState(false);
  const [wiringProgress,setWiringProgress] = useState<string[]>([]);
  const [routesConfigured,setRoutesConfigured] = useState(false);
  const [smokeAccepted,setSmokeAccepted] = useState(false);
  const [target,setTarget] = useState('');
  const [spender,setSpender] = useState('');
  const [selector,setSelector] = useState('');
  const [sampleToken,setSampleToken] = useState('');
  const [routeQuote,setRouteQuote] = useState<{tool:string;fromAmount:string;toAmountMin:string;target:Address;spender:Address;selector:Hex}|null>(null);
  const [finalized,setFinalized] = useState<Record<string,boolean>>({});

  const owner = isAddress(ownerInput) ? getAddress(ownerInput) : null;
  const treasury = isAddress(treasuryInput) ? getAddress(treasuryInput) : null;
  const onBase = chainId === base.id;
  const ownerConnected = !!address && !!owner && address.toLowerCase() === owner.toLowerCase();

  useEffect(() => {
    try {
      const raw=localStorage.getItem(STORAGE_KEY); if(!raw)return;
      const s=JSON.parse(raw);
      if(s.owner&&isAddress(s.owner))setOwnerInput(getAddress(s.owner));
      if(s.treasury&&isAddress(s.treasury))setTreasuryInput(getAddress(s.treasury));
      const a:State={}; for(const k of ORDER){if(s.addresses?.[k]&&isAddress(s.addresses[k]))a[k]=getAddress(s.addresses[k]);} setAddresses(a);
      setHashes(s.hashes||{}); setVerified(s.verified||{}); setRegistryReady(!!s.registryReady); setWired(!!s.wired); setRoutesConfigured(!!s.routesConfigured); setSmokeAccepted(!!s.smokeAccepted); setFinalized(s.finalized||{});
      setTarget(s.target||'');setSpender(s.spender||'');setSelector(s.selector||'');setSampleToken(s.sampleToken||'');
    } catch {}
  },[]);
  useEffect(()=>{if(address&&!ownerInput)setOwnerInput(address);if(address&&!treasuryInput)setTreasuryInput(address);},[address,ownerInput,treasuryInput]);
  useEffect(()=>{try{localStorage.setItem(STORAGE_KEY,JSON.stringify({owner:ownerInput,treasury:treasuryInput,addresses,hashes,verified,registryReady,wired,routesConfigured,smokeAccepted,finalized,target,spender,selector,sampleToken}));}catch{}},[ownerInput,treasuryInput,addresses,hashes,verified,registryReady,wired,routesConfigured,smokeAccepted,finalized,target,spender,selector,sampleToken]);

  function ready() {
    if(!isConnected||!address)throw new Error('Connect the deployment wallet first.');
    if(!onBase)throw new Error('Switch to Base mainnet first.');
    if(!publicClient||!walletClient)throw new Error('Base wallet client is not ready.');
    if(!owner||!treasury)throw new Error('Enter valid owner and treasury addresses.');
    if(!ownerConnected)throw new Error(`Connect the Protocol Owner wallet ${owner}.`);
    if(!mainnetAccepted)throw new Error('Confirm the Base mainnet acknowledgement.');
    return {owner,treasury};
  }

  async function connectWallet(){setError(null);if(!injected)return setError('No injected wallet detected.');setBusy('connect');reset();try{await connectAsync({connector:injected,chainId:base.id});}catch(e){setError(e instanceof Error?e.message:'Wallet connection failed.');}finally{setBusy(null);}}

  async function checkRegistry(){setError(null);setBusy('registry');try{if(!publicClient)throw new Error('Base client unavailable.');const code=await publicClient.getBytecode({address:EXISTING_ASSET_REGISTRY});if(!code||code==='0x')throw new Error('No contract bytecode found at the existing Asset Registry address on Base.');setRegistryReady(true);setNotice('Existing Asset Registry found on Base. V2.5 will reuse it; no registry redeployment is needed.');}catch(e){setRegistryReady(false);setError(e instanceof Error?e.message:'Registry check failed.');}finally{setBusy(null);}}

  function artifact(kind:Kind){
    if(kind==='vaultDeployer')return {abi:indexioV25VaultDeployerAbi,bytecode:indexioV25VaultDeployerBytecode,args:[] as readonly unknown[],verifyKind:'vaultDeployer'};
    if(kind==='factory'){if(!owner||!treasury||!addresses.vaultDeployer)throw new Error('Vault Deployer, owner, and treasury are required.');return {abi:indexioV25FactoryAbi,bytecode:indexioV25FactoryBytecode,args:[owner,EXISTING_ASSET_REGISTRY,BASE_USDC,treasury,addresses.vaultDeployer] as const,verifyKind:'factory'};}
    if(kind==='executionRouter'){if(!owner||!addresses.factory)throw new Error('Factory required.');return {abi:indexioV25ExecutionRouterAbi,bytecode:indexioV25ExecutionRouterBytecode,args:[owner,addresses.factory,BASE_USDC] as const,verifyKind:'executionRouter'};}
    if(kind==='rebalanceRouter'){if(!owner||!addresses.factory)throw new Error('Factory required.');return {abi:indexioV25RebalanceRouterAbi,bytecode:indexioV25RebalanceRouterBytecode,args:[owner,addresses.factory] as const,verifyKind:'rebalanceRouter'};}
    if(kind==='reinvestmentRouter'){if(!owner||!addresses.factory)throw new Error('Factory required.');return {abi:indexioV25ReinvestmentRouterAbi,bytecode:indexioV25ReinvestmentRouterBytecode,args:[owner,addresses.factory,BASE_USDC] as const,verifyKind:'reinvestmentRouter'};}
    const router=kind==='executionAdapter'?addresses.executionRouter:kind==='rebalanceAdapter'?addresses.rebalanceRouter:addresses.reinvestmentRouter;if(!owner||!router)throw new Error('Matching router required.');return {abi:indexioV25AdapterAbi,bytecode:indexioV25AdapterBytecode,args:[owner,router] as const,verifyKind:'adapter'};
  }
  function constructorArguments(kind:Kind):Hex{
    if(kind==='vaultDeployer')return '0x';
    const a=artifact(kind).args as readonly Address[];
    return encodeAbiParameters(a.map(()=>({type:'address'})) as any,a as any);
  }
  function previousReady(kind:Kind){const i=ORDER.indexOf(kind);if(i===0)return registryReady;const p=ORDER[i-1];return !!addresses[p]&&verified[p]==='verified';}

  async function deploy(kind:Kind){setError(null);setNotice(null);setBusy(`deploy:${kind}`);try{ready();if(!previousReady(kind))throw new Error('Complete and verify the previous deployment step first.');const a=artifact(kind);const data=encodeDeployData({abi:a.abi as any,bytecode:a.bytecode,args:a.args as any});await publicClient!.estimateGas({account:address!,data});const hash=await walletClient!.deployContract({account:address!,chain:base,abi:a.abi as any,bytecode:a.bytecode,args:a.args as any});setHashes(x=>({...x,[kind]:hash}));const receipt=await publicClient!.waitForTransactionReceipt({hash});if(receipt.status!=='success'||!receipt.contractAddress)throw new Error('Deployment transaction did not produce a contract address.');const deployed=getAddress(receipt.contractAddress);setAddresses(x=>({...x,[kind]:deployed}));setVerified(x=>({...x,[kind]:'idle'}));setNotice(`${LABEL[kind]} deployed. Verify it before continuing.`);}catch(e){setError(e instanceof Error?e.message:'Deployment failed.');}finally{setBusy(null);}}

  async function verifyContract(kind:Kind){setError(null);setBusy(`verify:${kind}`);setVerifyMessage(x=>({...x,[kind]:'Contacting Base Blockscout…'}));try{const a=addresses[kind];if(!a)throw new Error('No deployed address to verify.');setVerified(x=>({...x,[kind]:'pending'}));const r=await fetch('/api/blockscout/verify-indexio-v25',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:artifact(kind).verifyKind,address:a,constructorArguments:constructorArguments(kind)})});const j=await r.json();if(!r.ok)throw new Error(j.error||'Verification failed.');const message=j.message||'Verification submitted.';setVerified(x=>({...x,[kind]:j.verified?'verified':'pending'}));setVerifyMessage(x=>({...x,[kind]:message}));setNotice(message);}catch(e){const message=e instanceof Error?e.message:'Verification failed.';setVerified(x=>({...x,[kind]:'error'}));setVerifyMessage(x=>({...x,[kind]:message}));setError(message);}finally{setBusy(null);}}

  async function write(address_: Address, abi: any, functionName: string, args: readonly unknown[] = []) {
    if (!walletClient || !publicClient || !address) throw new Error('Base wallet client is not ready.');
    const data = encodeFunctionData({ abi, functionName, args } as any);
    const hash = await walletClient.sendTransaction({
      account: address,
      chain: base,
      to: address_,
      data,
    });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${functionName} reverted.`);
    return hash;
  }

  async function readCall<T>(contract: Address, abi: any, functionName: string, args: readonly unknown[] = []) {
    if (!publicClient) throw new Error('Base client unavailable.');
    return await publicClient.readContract({ address: contract, abi, functionName, args } as any) as T;
  }

  async function getWiringStatus() {
    const f=addresses.factory, er=addresses.executionRouter, br=addresses.rebalanceRouter, rr=addresses.reinvestmentRouter;
    const ea=addresses.executionAdapter, ba=addresses.rebalanceAdapter, ra=addresses.reinvestmentAdapter;
    if(!f||!er||!br||!rr||!ea||!ba||!ra)throw new Error('All V2.5 contracts must be deployed first.');
    const [executionApproved,rebalanceApproved,reinvestmentApproved,defaultRouter,executionAdapterApproved,rebalanceAdapterApproved,reinvestmentAdapterApproved] = await Promise.all([
      readCall<boolean>(f,factoryAdminAbi,'isExecutionRouter',[er]),
      readCall<boolean>(f,factoryAdminAbi,'isRebalanceRouter',[br]),
      readCall<boolean>(f,factoryAdminAbi,'isReinvestmentRouter',[rr]),
      readCall<Address>(f,factoryAdminAbi,'defaultReinvestmentRouter',[]),
      readCall<boolean>(er,routerAdminAbi,'approvedAdapter',[ea]),
      readCall<boolean>(br,routerAdminAbi,'approvedAdapter',[ba]),
      readCall<boolean>(rr,routerAdminAbi,'approvedAdapter',[ra]),
    ]);
    return {
      executionApproved, rebalanceApproved, reinvestmentApproved,
      defaultRouterSet: defaultRouter.toLowerCase()===rr.toLowerCase(),
      executionAdapterApproved, rebalanceAdapterApproved, reinvestmentAdapterApproved,
    };
  }

  async function refreshWiringStatus(showNotice=true){
    setError(null);setBusy('wire-check');
    try{
      ready();
      const s=await getWiringStatus();
      const rows=[
        ['Execution Router approved',s.executionApproved],
        ['Rebalance Router approved',s.rebalanceApproved],
        ['Reinvestment Router approved',s.reinvestmentApproved],
        ['Default Reinvestment Router set',s.defaultRouterSet],
        ['Execution Adapter approved',s.executionAdapterApproved],
        ['Rebalance Adapter approved',s.rebalanceAdapterApproved],
        ['Reinvestment Adapter approved',s.reinvestmentAdapterApproved],
      ] as const;
      setWiringProgress(rows.map(([label,ok])=>`${ok?'✓':'○'} ${label}`));
      const complete=rows.every(([,ok])=>ok);setWired(complete);
      if(showNotice)setNotice(complete?'Bootstrap wiring is already complete onchain. No more wiring transactions are needed.':'Wiring status refreshed. Only missing permissions will be submitted.');
      return {status:s,complete};
    }catch(e){setError(e instanceof Error?e.message:'Could not read bootstrap wiring status.');return null;}finally{setBusy(null);}
  }

  async function bootstrapWire(){
    setError(null);setBusy('wire');
    try{
      ready();
      for(const k of ORDER)if(!addresses[k]||verified[k]!=='verified')throw new Error(`Verify ${LABEL[k]} first.`);
      const f=addresses.factory!,er=addresses.executionRouter!,br=addresses.rebalanceRouter!,rr=addresses.reinvestmentRouter!;
      const ea=addresses.executionAdapter!,ba=addresses.rebalanceAdapter!,ra=addresses.reinvestmentAdapter!;
      let s=await getWiringStatus();
      const steps:[string,()=>Promise<Hex>,keyof typeof s][]=[
        ['Approve Execution Router',()=>write(f,factoryAdminAbi,'setExecutionRouter',[er,true]),'executionApproved'],
        ['Approve Rebalance Router',()=>write(f,factoryAdminAbi,'setRebalanceRouter',[br,true]),'rebalanceApproved'],
        ['Approve Reinvestment Router',()=>write(f,factoryAdminAbi,'setReinvestmentRouter',[rr,true]),'reinvestmentApproved'],
        ['Set default Reinvestment Router',()=>write(f,factoryAdminAbi,'setDefaultReinvestmentRouter',[rr]),'defaultRouterSet'],
        ['Approve Execution Adapter',()=>write(er,routerAdminAbi,'setAdapter',[ea,true]),'executionAdapterApproved'],
        ['Approve Rebalance Adapter',()=>write(br,routerAdminAbi,'setAdapter',[ba,true]),'rebalanceAdapterApproved'],
        ['Approve Reinvestment Adapter',()=>write(rr,routerAdminAbi,'setAdapter',[ra,true]),'reinvestmentAdapterApproved'],
      ];
      let sent=0;
      for(const [label,send,key] of steps){
        if(s[key])continue;
        setNotice(`${label} — confirm this transaction in your wallet. ${sent} new wiring transaction${sent===1?'':'s'} completed this run.`);
        await send();sent++;
        s=await getWiringStatus();
        if(!s[key])throw new Error(`${label} transaction confirmed, but the expected onchain permission is still not set.`);
      }
      const rows=[
        ['Execution Router approved',s.executionApproved],['Rebalance Router approved',s.rebalanceApproved],['Reinvestment Router approved',s.reinvestmentApproved],['Default Reinvestment Router set',s.defaultRouterSet],['Execution Adapter approved',s.executionAdapterApproved],['Rebalance Adapter approved',s.rebalanceAdapterApproved],['Reinvestment Adapter approved',s.reinvestmentAdapterApproved],
      ] as const;
      setWiringProgress(rows.map(([label,ok])=>`${ok?'✓':'○'} ${label}`));
      const complete=rows.every(([,ok])=>ok);setWired(complete);
      if(!complete)throw new Error('Bootstrap wiring stopped before all permissions were confirmed. Re-run it; completed steps will now be skipped.');
      setNotice(sent===0?'Bootstrap wiring was already complete onchain. No transaction was sent.':`Bootstrap wiring complete. ${sent} missing transaction${sent===1?' was':'s were'} submitted; previously completed steps were skipped.`);
    }catch(e){setError(e instanceof Error?e.message:'Bootstrap wiring failed.');}finally{setBusy(null);}
  }

  async function fetchLifiRoute(){
    setError(null);setNotice(null);setBusy('lifi-route');setRouteQuote(null);
    try{
      ready();
      if(!wired)throw new Error('Complete bootstrap wiring first.');
      if(!isAddress(sampleToken))throw new Error('Enter one enabled Asset Registry token address to sample.');
      const token=getAddress(sampleToken);
      const cfg=await readCall<readonly [boolean,number,number]>(EXISTING_ASSET_REGISTRY,assetRegistryReadAbi,'config',[token]);
      if(!cfg[0])throw new Error('That token is not currently enabled in the existing Asset Registry.');
      const r=await fetch('/api/lifi/route',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({toToken:token,fromAddress:address})});
      const j=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(j?.error||`LI.FI route lookup failed (${r.status}).`);
      if(!isAddress(j.target)||!isAddress(j.spender)||!/^0x[0-9a-fA-F]{8}$/.test(j.selector))throw new Error('LI.FI returned an incomplete or invalid route tuple.');
      const t=getAddress(j.target),sp=getAddress(j.spender),sel=j.selector as Hex;
      const [targetCode,spenderCode]=await Promise.all([publicClient!.getBytecode({address:t}),publicClient!.getBytecode({address:sp})]);
      if(!targetCode||targetCode==='0x')throw new Error('LI.FI target has no bytecode on Base; refusing to pre-approve it.');
      if(!spenderCode||spenderCode==='0x')throw new Error('LI.FI approval spender has no bytecode on Base; refusing to pre-approve it.');
      setTarget(t);setSpender(sp);setSelector(sel);
      setRouteQuote({tool:String(j.tool||'LI.FI'),fromAmount:String(j.fromAmount||''),toAmountMin:String(j.toAmountMin||''),target:t,spender:sp,selector:sel});
      setRoutesConfigured(false);
      setNotice('Live LI.FI Base quote validated. Review the populated target, spender, and selector before enabling it on the adapters.');
    }catch(e){setError(e instanceof Error?e.message:'Could not fetch a reviewed LI.FI route.');}
    finally{setBusy(null);}
  }

  async function configureRoutes(){setError(null);setBusy('routes');try{ready();if(!wired)throw new Error('Wire V2.5 first.');if(!isAddress(target)||!isAddress(spender)||!/^0x[0-9a-fA-F]{8}$/.test(selector))throw new Error('Enter reviewed target, spender, and 4-byte selector (0x + 8 hex chars).');for(const k of ['executionAdapter','rebalanceAdapter','reinvestmentAdapter'] as Kind[])await write(addresses[k]!,adapterAdminAbi,'setRoute',[getAddress(target),getAddress(spender),selector as Hex,true]);setRoutesConfigured(true);setNotice('Reviewed route tuple enabled on all three dedicated adapters.');}catch(e){setError(e instanceof Error?e.message:'Route configuration failed.');}finally{setBusy(null);}}

  async function finalizeOne(key:string,contract:Address,abi:any){setError(null);setBusy(`finalize:${key}`);try{ready();if(!routesConfigured||!smokeAccepted)throw new Error('Configure the route and confirm the V2.5 smoke tests before finalization.');await write(contract,abi,'finalizeBootstrap',[]);setFinalized(x=>({...x,[key]:true}));setNotice(`${key} bootstrap finalized permanently.`);}catch(e){setError(e instanceof Error?e.message:'Finalization failed.');}finally{setBusy(null);}}
  const adaptersDone=['executionAdapter','rebalanceAdapter','reinvestmentAdapter'].every(k=>finalized[k]);
  const routersDone=['executionRouter','rebalanceRouter','reinvestmentRouter'].every(k=>finalized[k]);

  return <main className="shell">
    <section className="hero"><div className="brandRow"><div className="mark">I</div><div><div className="eyebrow">INDEXIO V2.5</div><div className="networkPill"><i/>Base mainnet deployment center</div></div></div><h1>Deploy V2.5 safely, in order.</h1><p>This flow reuses the existing Asset Registry, deploys only the new V2.5 stack, verifies every contract on Base Blockscout, wires bootstrap permissions, then finalizes authority in the safe order.</p></section>

    <section className="card"><div className="stepHead"><div className="stepNo">01</div><div><h2>Wallet & governance</h2><p>The connected wallet must be the Protocol Owner during bootstrap.</p></div></div>{!isConnected?<button className="primary" onClick={connectWallet} disabled={!!busy}>Connect wallet</button>:<div className="walletBox"><div><span>CONNECTED</span><b>{address}</b></div><button className="ghost compact" onClick={()=>disconnect()}>Disconnect</button></div>}{isConnected&&!onBase&&<button className="secondary" onClick={()=>switchChainAsync({chainId:base.id})} disabled={switching}>Switch to Base</button>}<label className="field">Protocol Owner<input value={ownerInput} onChange={e=>setOwnerInput(e.target.value)} placeholder="0x…"/></label><label className="field">Fee Treasury<input value={treasuryInput} onChange={e=>setTreasuryInput(e.target.value)} placeholder="0x…"/></label><label className="check"><input type="checkbox" checked={mainnetAccepted} onChange={e=>setMainnetAccepted(e.target.checked)}/><span>I understand these transactions deploy and configure contracts on Base mainnet and bootstrap finalization is irreversible.</span></label></section>

    <section className="card"><div className="stepHead"><div className="stepNo">02</div><div><h2>Reuse Asset Registry</h2><p>V2.5 does not redeploy your populated registry.</p></div></div><div className="contractBox"><span>EXISTING REGISTRY</span><strong>{EXISTING_ASSET_REGISTRY}</strong></div><button className="primary" onClick={checkRegistry} disabled={busy==='registry'}>{registryReady?'Registry confirmed ✓':'Confirm registry bytecode on Base'}</button><a className="linkButton" href={explorerAddress(EXISTING_ASSET_REGISTRY)} target="_blank" rel="noreferrer">Open registry on Blockscout</a></section>

    {ORDER.map((kind,i)=>{const a=addresses[kind];const v=verified[kind]||'idle';const canDeploy=previousReady(kind)&&!a;return <section className="card" key={kind}><div className="stepHead"><div className="stepNo">{String(i+3).padStart(2,'0')}</div><div><h2>{LABEL[kind]}</h2><p>{a?'Deployed. Verify source before moving to the next dependency.':'Deploys only after the previous dependency is confirmed.'}</p></div></div>{a?<><div className="contractBox"><span>ADDRESS</span><strong>{a}</strong></div>{hashes[kind]&&<a className="linkButton" href={explorerTx(hashes[kind]!)} target="_blank" rel="noreferrer">View deployment transaction</a>}<a className="linkButton" href={explorerAddress(a)} target="_blank" rel="noreferrer">Open contract on Blockscout</a><button className="primary" onClick={()=>verifyContract(kind)} disabled={busy===`verify:${kind}`||v==='verified'}>{busy===`verify:${kind}`?'Checking Blockscout…':v==='verified'?'Verified ✓':v==='pending'?'Check verification status':'Verify source on Blockscout'}</button>{verifyMessage[kind]&&<div className={`notice ${v==='error'?'error':''}`}><b>Blockscout</b><p>{verifyMessage[kind]}</p></div>}</>:<button className="primary deploy" onClick={()=>deploy(kind)} disabled={!canDeploy||!!busy}>Deploy {LABEL[kind]}</button>}</section>})}

    <section className="card"><div className="stepHead"><div className="stepNo">11</div><div><h2>Bootstrap wiring</h2><p>Seven one-time permissions are required. This screen now reads Base first and submits only the missing transactions, so it is safe to resume after an interruption.</p></div></div><button className="ghost" onClick={()=>refreshWiringStatus()} disabled={!ORDER.every(k=>verified[k]==='verified')||!!busy}>{busy==='wire-check'?'Reading Base…':'Check wiring status'}</button>{wiringProgress.length>0&&<div className="notice"><b>Onchain wiring status</b>{wiringProgress.map(x=><p key={x}>{x}</p>)}</div>}<button className="primary" onClick={bootstrapWire} disabled={!ORDER.every(k=>verified[k]==='verified')||wired||!!busy}>{busy==='wire'?'Wiring missing permissions…':wired?'Bootstrap wiring complete ✓':'Wire only missing permissions'}</button></section>

    <section className="card"><div className="stepHead"><div className="stepNo">12</div><div><h2>Reviewed swap route</h2><p>Fetch a live same-chain Base quote from LI.FI. The deployer verifies the sample token is enabled in your existing Asset Registry, then extracts and validates the exact target + spender + function selector tuple.</p></div></div><label className="field">Registered asset to sample<input value={sampleToken} onChange={e=>{setSampleToken(e.target.value);setRouteQuote(null);setRoutesConfigured(false);}} placeholder="0x… enabled asset address"/></label><button className="secondary" onClick={fetchLifiRoute} disabled={!wired||!!busy}>{busy==='lifi-route'?'Fetching & validating LI.FI route…':'Fetch live LI.FI Base route'}</button>{routeQuote&&<div className="notice"><b>Live route found</b><p>Tool: {routeQuote.tool}</p><p>Quote sample: 10 USDC. This lookup is for permission discovery only; it does not execute a swap.</p></div>}<label className="field">Target<input value={target} readOnly placeholder="Fetched from LI.FI"/></label><label className="field">Spender<input value={spender} readOnly placeholder="Fetched from LI.FI"/></label><label className="field">Function selector<input value={selector} readOnly placeholder="Fetched from LI.FI"/></label><button className="primary" onClick={configureRoutes} disabled={!wired||!routeQuote||routesConfigured||!!busy}>{routesConfigured?'Routes configured ✓':'Enable this reviewed route on all adapters'}</button><div className="notice"><b>Important.</b> LI.FI can return different route tuples for different assets/tools. This approves only the exact tuple shown above. Additional tuples can be reviewed and added during bootstrap, or later through the 6-hour route timelock.</div><div className="notice"><b>Do not finalize yet.</b> Run seed, buy, sell, rebalance, distribution, tiny-income reinvestment, normal reinvestment, pause/close, and recovery smoke tests first.</div><label className="check"><input type="checkbox" checked={smokeAccepted} onChange={e=>setSmokeAccepted(e.target.checked)}/><span>I completed the V2.5 smoke-test checklist against these exact deployed addresses and the results are green.</span></label></section>

    <section className="card"><div className="stepHead"><div className="stepNo">13</div><div><h2>Irreversible finalization</h2><p>Finalize adapters first, then routers, then the Factory last. The Factory remains closed to public index launches until the final step.</p></div></div>{(['executionAdapter','rebalanceAdapter','reinvestmentAdapter'] as Kind[]).map(k=><button key={k} className="ghost" onClick={()=>finalizeOne(k,addresses[k]!,adapterAdminAbi)} disabled={!routesConfigured||!smokeAccepted||!addresses[k]||finalized[k]||!!busy}>{finalized[k]?`${LABEL[k]} finalized ✓`:`Finalize ${LABEL[k]}`}</button>)}{(['executionRouter','rebalanceRouter','reinvestmentRouter'] as Kind[]).map(k=><button key={k} className="ghost" onClick={()=>finalizeOne(k,addresses[k]!,routerAdminAbi)} disabled={!adaptersDone||!addresses[k]||finalized[k]||!!busy}>{finalized[k]?`${LABEL[k]} finalized ✓`:`Finalize ${LABEL[k]}`}</button>)}<button className="secondary" onClick={()=>finalizeOne('factory',addresses.factory!,factoryAdminAbi)} disabled={!routersDone||!addresses.factory||finalized.factory||!!busy}>{finalized.factory?'Factory finalized — V2.5 live ✓':'FINALIZE FACTORY LAST'}</button></section>

    {notice&&<div className="notice success strong">{notice}</div>}{error&&<div className="card error"><b>Action stopped safely</b><p>{error}</p></div>}
    <footer>V2.5 registry reuse: {EXISTING_ASSET_REGISTRY}. Base USDC: {BASE_USDC}. Verification pending is not a reason to redeploy; recheck the same address instead.</footer>
  </main>;
}
