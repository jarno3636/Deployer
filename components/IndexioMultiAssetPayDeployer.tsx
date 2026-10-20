'use client';
import {useEffect,useState} from 'react';
import {useAccount,useConnect,usePublicClient,useSwitchChain,useWalletClient} from 'wagmi';
import {base} from 'viem/chains';
import {encodeDeployData,getAddress,isAddress,keccak256,type Hash} from 'viem';
import {payV2Abi,payV2Bytecode,payV2Compiler} from '../lib/indexio-pay-v2.generated';

const KEY='indexio-pay-v2-base-deployment';
const short=(s:string)=>s.length>18?`${s.slice(0,10)}…${s.slice(-8)}`:s;
const failure=(error:unknown)=>error instanceof Error?error.message.slice(0,360):'This operation could not be completed.';
type RecordState={treasury:string;hash:string;contract:string;codeHash:string};
const empty:RecordState={treasury:'0x3118FE32B27651734fe4D966D1bC240bE6e3139D',hash:'',contract:'',codeHash:''};
export function IndexioMultiAssetPayDeployer(){
 const {address,isConnected,chainId}=useAccount();
 const {connectAsync,connectors}=useConnect();
 const {switchChainAsync}=useSwitchChain();
 const pc=usePublicClient({chainId:8453});
 const {data:wc}=useWalletClient({chainId:8453});
 const [record,setRecord]=useState<RecordState>(empty);
 const [loaded,setLoaded]=useState(false);
 const [reviewed,setReviewed]=useState(false);
 const [busy,setBusy]=useState(false);
 const [notice,setNotice]=useState('');
 const [error,setError]=useState('');
 const [restore,setRestore]=useState('');
 useEffect(()=>{try{const value=localStorage.getItem(KEY);if(value){const saved=JSON.parse(value);setRecord({...empty,...saved});}}catch{}setLoaded(true)},[]);
 useEffect(()=>{if(loaded)try{localStorage.setItem(KEY,JSON.stringify(record));}catch{}},[loaded,record]);
 const validTreasury=isAddress(record.treasury)&&getAddress(record.treasury)!==getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
 const canDeploy=loaded&&isConnected&&chainId===8453&&!!pc&&!!wc&&validTreasury&&reviewed&&!busy&&!record.hash&&payV2Bytecode.length>10;
 async function inspect(hash:string){
  if(!pc||!/^0x[0-9a-fA-F]{64}$/.test(hash))throw Error('Enter the original deployment transaction hash.');
  const receipt=await pc.getTransactionReceipt({hash:hash as Hash});
  if(receipt.status!=='success'||!receipt.contractAddress)throw Error('No successful contract deployment found.');
  const tx=await pc.getTransaction({hash:hash as Hash});
  if(tx.to!==null||tx.chainId!==8453)throw Error('Not a Base contract creation transaction.');
  if(!tx.input.toLowerCase().startsWith(payV2Bytecode.toLowerCase()))throw Error('Deployment bytecode does not match the compiled V2 release.');
  const [treasury,bps,maximum,code]=await Promise.all([
   pc.readContract({address:receipt.contractAddress,abi:payV2Abi,functionName:'treasury'}),
   pc.readContract({address:receipt.contractAddress,abi:payV2Abi,functionName:'FEE_BPS'}),
   pc.readContract({address:receipt.contractAddress,abi:payV2Abi,functionName:'MAX_USDC_FEE'}),
   pc.getBytecode({address:receipt.contractAddress}),
  ]);
  if(!code||code==='0x'||bps!==10n||maximum!==20_000_000n)throw Error('Deployed contract checks do not match Indexio Pay V2.');
  return {treasury:treasury as string,hash,contract:receipt.contractAddress,codeHash:keccak256(code)};
 }
 async function deploy(){
  if(!canDeploy||!pc||!wc||!address)return;
  setBusy(true);setError('');setNotice('');let tx:Hash|undefined;
  try{
   const treasury=getAddress(record.treasury);
   const data=encodeDeployData({abi:payV2Abi,bytecode:payV2Bytecode,args:[treasury]});
   await pc.estimateGas({account:address,data});
   tx=await wc.deployContract({account:address,chain:base,abi:payV2Abi,bytecode:payV2Bytecode,args:[treasury]});
   setRecord(r=>({...r,hash:tx!,contract:''}));
   setNotice('Deployment submitted. Waiting for Base confirmation—do not deploy again.');
   const result=await pc.waitForTransactionReceipt({hash:tx,confirmations:1,timeout:180000});
   if(result.status!=='success')throw Error('Deployment reverted.');
   setRecord(await inspect(tx));
   setNotice('New Pay contract confirmed. Verify the source on BaseScan before activating it in Indexio.');
  }catch(e){setError(`${tx?'The deployment may already have been sent. Refresh its status instead of deploying again. ':''}${failure(e)}`)}
  finally{setBusy(false)}
 }
 async function refresh(hash=record.hash){setBusy(true);setError('');try{const verified=await inspect(hash);setRecord(verified);setRestore('');setNotice('Deployment address and permanent fee settings confirmed.');}catch(e){setError(failure(e))}finally{setBusy(false)}}
 async function copy(){try{await navigator.clipboard.writeText(JSON.stringify({NEXT_PUBLIC_INDEXIO_MULTIASSET_PAY_ROUTER:record.contract,NEXT_PUBLIC_INDEXIO_MULTIASSET_PAY_ENABLED:'true',NEXT_PUBLIC_INDEXIO_MULTIASSET_PAY_CODE_HASH:record.codeHash,INDEXIO_MULTIASSET_PAY_DEPLOY_TX:record.hash,treasury:record.treasury,chainId:8453,feeBps:10,usdcCap:'20 USDC only',hash:record.hash},null,2));setNotice('Deployment settings copied.')}catch{setError('Clipboard access unavailable.')}}
 return <main className="payShell">
  <header className="payHero"><span className="payLabel">INDEXIO PAY · VERSION 2</span><h1>One fee.<br/><em>More assets.</em></h1><p>Deploy a separate fixed-fee contract for ETH and compatible tokens on Base. Your existing USDC Pay stays unchanged.</p><div className="payChips"><span>BASE MAINNET</span><span>0.1% IN THE ASSET SENT</span><span>NO OWNER UPGRADES</span></div></header>
  <div className="payStats"><div><small>PAYMENT FEE</small><strong>0.1%</strong><span>Paid in the asset being sent</span></div><div><small>USDC FEE CAP</small><strong>20 USDC</strong><span>No universal USD cap for other assets</span></div><div><small>YOUR CONTROL</small><strong>Self-custody</strong><span>No ongoing administrator approval</span></div></div>
  <section className="payCard"><div className="paySectionHead"><span>01</span><div><h2>Connect your wallet</h2><p>Deploy once on Base. Deployment needs ETH for network fees.</p></div></div>
   <div className="payWallet"><div><small>CURRENT WALLET</small><strong>{address?short(address):'Not connected'}</strong><span>{chainId===8453?'Base selected':'Base is required'}</span></div>{!isConnected?<button type="button" onClick={()=>{const connector=connectors[0];if(connector)void connectAsync({connector});else setError('Open this page in a wallet browser.')}}>Connect</button>:chainId!==8453?<button type="button" onClick={()=>void switchChainAsync({chainId:8453})}>Switch to Base</button>:<span className="payConnected">Ready</span>}</div>
  </section>
  <section className="payCard"><div className="paySectionHead"><span>02</span><div><h2>Choose the fee wallet</h2><p>Use the same verified Indexio Pay fee wallet unless deliberately changing your accounting. The app will reject a different treasury until its configuration is reviewed.</p></div></div>
   <label className="payInputLabel" htmlFor="multi-pay-treasury">FEE WALLET ON BASE</label>
   <input id="multi-pay-treasury" className="payInput" value={record.treasury} onChange={e=>{setRecord(r=>({...r,treasury:e.target.value}));setReviewed(false)}} placeholder="0x…" disabled={busy||!!record.hash} autoComplete="off" spellCheck={false}/>
   <p className="payHint">Standard tokens: 0.1%. Native Base USDC: 0.1%, capped at 20 USDC. Other assets have no equivalent dollar cap. Tokens with transfer taxes may deliver less than estimated; the contract measures the actual result.</p>
   <label className="payApprove"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)} disabled={!!record.hash}/><span>I reviewed the contract and treasury address. I understand deployments cannot be undone, and this new router does not replace the existing USDC router.</span></label>
   {!record.hash&&<button className="payPrimary" type="button" disabled={!canDeploy} onClick={()=>void deploy()}>{busy?'Waiting for wallet…':'Deploy multi-asset Pay V2'}</button>}
   <p className="payTiny">Compiled with {payV2Compiler}, optimizer 200, Cancun EVM. Source must be independently audited and verified before public use.</p>
  </section>
  <section className="payCard"><div className="paySectionHead"><span>03</span><div><h2>Confirm the contract</h2><p>Keep the deployment transaction and address so you can recover after closing the wallet.</p></div></div>
   {record.hash?<div className="payRecord"><div><span>TRANSACTION</span><code>{record.hash}</code><a href={`https://basescan.org/tx/${record.hash}`} target="_blank" rel="noreferrer">View on BaseScan ↗</a></div><div><span>CONTRACT</span><code>{record.contract||'Waiting for confirmation'}</code>{record.contract&&<a href={`https://basescan.org/address/${record.contract}#code`} target="_blank" rel="noreferrer">Verify contract code ↗</a>}</div><button type="button" className="payOutline" disabled={busy} onClick={()=>void refresh()}>Refresh deployment</button></div>:<div className="payRestore"><label className="payInputLabel" htmlFor="multi-pay-restore">RESTORE PREVIOUS DEPLOYMENT</label><div><input id="multi-pay-restore" placeholder="0x… deployment transaction hash" value={restore} onChange={e=>setRestore(e.target.value)}/><button type="button" disabled={busy||!restore} onClick={()=>void refresh(restore)}>Restore</button></div></div>}
  </section>
  {record.contract&&<section className="payCard"><div className="paySectionHead"><span>04</span><div><h2>Connect it to Indexio</h2><p>Verify the contract first. Then copy these settings into the app environment and redeploy the frontend.</p></div></div><pre className="payIntegration">{JSON.stringify({NEXT_PUBLIC_INDEXIO_MULTIASSET_PAY_ROUTER:record.contract,NEXT_PUBLIC_INDEXIO_MULTIASSET_PAY_ENABLED:'true',NEXT_PUBLIC_INDEXIO_MULTIASSET_PAY_CODE_HASH:record.codeHash,INDEXIO_MULTIASSET_PAY_DEPLOY_TX:record.hash,treasury:record.treasury},null,2)}</pre><button className="payOutline" type="button" onClick={()=>void copy()}>Copy settings</button><p className="payHint">The app must check the live treasury, fee constants and bytecode before offering the V2 payment option. Do not publish a contract address based only on this browser record.</p></section>}
  {(error||notice)&&<div role="status" className={`payNotice ${error?'payError':''}`}>{error||notice}</div>}
 </main>;
}
