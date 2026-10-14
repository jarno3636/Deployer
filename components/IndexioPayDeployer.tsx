'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { base } from 'viem/chains';
import {
 createWalletClient, custom, decodeAbiParameters, encodeDeployData,
 getAddress, isAddress, isHex, type Address, type Hex,
} from 'viem';
import { indexioPayAbi, indexioPayBytecode, indexioPayCompiler } from '../lib/indexio-pay.generated';

const STORAGE='indexio-pay-router-v1-mainnet';
const USDC=getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const EXPLORER='https://basescan.org';
type RecordState={treasury:string;transactionHash:string;contractAddress:string;guid:string;verification:'idle'|'pending'|'verified'|'failed'};
const EMPTY:RecordState={treasury:'',transactionHash:'',contractAddress:'',guid:'',verification:'idle'};
const short=(value:string)=>value?`${value.slice(0,8)}…${value.slice(-6)}`:'';
const errText=(error:unknown)=>{
 const e=error as {shortMessage?:string;message?:string};
 return String(e?.shortMessage||e?.message||error||'Unexpected wallet error.').slice(0,420);
};

export function IndexioPayDeployer(){
 const {address,isConnected,chainId,connector}=useAccount();
 const {connectAsync,connectors}=useConnect();
 const {switchChainAsync}=useSwitchChain();
 const pc=usePublicClient({chainId:base.id});
 const {data:wc}=useWalletClient({chainId:base.id});
 const [record,setRecord]=useState<RecordState>(EMPTY);
 const [loaded,setLoaded]=useState(false);
 const [approved,setApproved]=useState(false);
 const [busy,setBusy]=useState('');
 const [notice,setNotice]=useState('');
 const [error,setError]=useState('');
 const [restoreHash,setRestoreHash]=useState('');
 useEffect(()=>{try{const raw=localStorage.getItem(STORAGE);if(raw){const saved=JSON.parse(raw);setRecord({...EMPTY,...saved});}}catch{}finally{setLoaded(true)}},[]);
 useEffect(()=>{if(loaded)try{localStorage.setItem(STORAGE,JSON.stringify(record))}catch{}},[loaded,record]);
 const treasuryValid=isAddress(record.treasury)&&getAddress(record.treasury)!==USDC&&record.treasury!=='0x0000000000000000000000000000000000000000';
 const feeExamples=useMemo(()=>[{sent:100,fee:0.10,received:99.90},{sent:1000,fee:1,received:999},{sent:25000,fee:20,received:24980}],[]);
 const canDeploy=loaded&&!busy&&isConnected&&chainId===base.id&&treasuryValid&&approved&&!record.transactionHash&&Boolean(pc);
 const canVerify=loaded&&!busy&&Boolean(record.contractAddress&&record.transactionHash&&record.treasury);
 const integration={network:'Base Mainnet',chainId:8453,contractAddress:record.contractAddress||null,transactionHash:record.transactionHash||null,
  feeTreasury:record.treasury||null,usdc:USDC,feeBps:10,maxFeeUsdc:20,feeFromTotal:true,
  function:'pay(address recipient,uint256 totalAmount)',event:'PaymentSent(address payer,address recipient,uint256 totalAmount,uint256 recipientAmount,uint256 feeAmount)',
  compiler:indexioPayCompiler,verification:record.verification};

 async function connect(){setError('');try{if(!connectors.length)throw Error('No injected wallet is available. Open this page in MetaMask or install an injected wallet.');await connectAsync({connector:connectors[0]});setNotice('Wallet connected. Check the Base network before deploying.')}catch(e){setError(errText(e))}}
 async function switchBase(){setError('');try{await switchChainAsync({chainId:base.id});setNotice('Base Mainnet selected.')}catch(e){setError(errText(e))}}
 async function walletClient(){
  if(wc)return wc;
  if(!connector||!address)throw Error('Wallet connection is unavailable. Reconnect and try again.');
  const provider=await connector.getProvider({chainId:base.id});
  if(!provider)throw Error('Wallet did not provide a signing connection.');
  return createWalletClient({chain:base,account:address,transport:custom(provider as Parameters<typeof custom>[0])});
 }
 async function inspect(hash:string){
  if(!pc)throw Error('Base network connection is unavailable. Try Refresh again.');
  if(!isHex(hash,{strict:true})||hash.length!==66)throw Error('Enter a valid 66-character Base transaction hash.');
  const receipt=await pc.getTransactionReceipt({hash:hash as Hex});
  if(receipt.status!=='success'||!receipt.contractAddress)throw Error('This transaction did not successfully create a contract.');
  const transaction=await pc.getTransaction({hash:hash as Hex});
  // The wallet transaction type already excludes Base deposit transactions.
  // Confirm this was a direct contract creation on Base Mainnet.
  if(transaction.to!==null||transaction.chainId!==base.id)throw Error('This is not a Base Mainnet contract creation transaction.');
  const input=transaction.input.toLowerCase();
  if(!input.startsWith(indexioPayBytecode.toLowerCase())||input.length!==indexioPayBytecode.length+64)
   throw Error('This transaction does not match the exact Indexio Pay Router build included here.');
  const encoded=(`0x${input.slice(indexioPayBytecode.length)}`) as Hex;
  const [feeTreasury]=decodeAbiParameters([{type:'address'}],encoded);
  const code=await pc.getCode({address:receipt.contractAddress});
  if(!code||code==='0x')throw Error('No contract bytecode is present at the deployment address.');
  return {treasury:feeTreasury,transactionHash:hash,contractAddress:receipt.contractAddress};
 }
 async function deploy(){
  if(!canDeploy||!pc||!address)return;
  setError('');setNotice('');setBusy('deploy');
  let submitted:Hex|undefined;
  try{
   const treasury=getAddress(record.treasury);
   if(treasury===getAddress(address))setNotice('The treasury and deployer are the same wallet. That wallet cannot send payments through this contract, by design.');
   const code=await pc.getCode({address:USDC});
   if(!code||code==='0x')throw Error('Base USDC could not be confirmed on-chain. Deployment stopped.');
   const data=encodeDeployData({abi:indexioPayAbi,bytecode:indexioPayBytecode,args:[treasury]});
   await pc.estimateGas({account:address,data});
   const signer=await walletClient();
   submitted=await (signer.deployContract as any)({abi:indexioPayAbi,bytecode:indexioPayBytecode,args:[treasury],account:address,chain:base}) as Hex;
   setRecord(r=>({...r,treasury,transactionHash:submitted!,contractAddress:'',guid:'',verification:'idle'}));
   setNotice('Transaction submitted. Waiting for Base confirmation. Do not deploy a second copy.');
   const receipt=await pc.waitForTransactionReceipt({hash:submitted,timeout:120_000,pollingInterval:3_000});
   if(receipt.status!=='success'||!receipt.contractAddress)throw Error('Deployment reverted. Review the transaction on BaseScan.');
   const found=await inspect(submitted);
   setRecord(r=>({...r,...found}));setNotice('Pay Router deployed and confirmed. You can now verify it on BaseScan.');
  }catch(e){
   setError(submitted?`Deployment transaction ${short(submitted)} was submitted. ${errText(e)} Use “Refresh deployment” before doing anything else; do not send another deployment.`:errText(e));
  }finally{setBusy('')}
 }
 async function refresh(hash=record.transactionHash){
  setBusy('refresh');setError('');setNotice('');
  try{
   const found=await inspect(hash.trim());
   setRecord(r=>({...r,...found,...(r.transactionHash.toLowerCase()!==found.transactionHash.toLowerCase()?{guid:'',verification:'idle' as const}:{})}));
   setRestoreHash('');setNotice('Contract and permanent fee treasury confirmed against the Base deployment transaction.');
  }catch(e){setError(`${errText(e)} If the transaction is still pending, try Refresh again. Do not redeploy.`)}finally{setBusy('')}
 }
 async function verify(mode:'verify'|'check'){
  if(!canVerify)return;
  setBusy(mode);setError('');setNotice('');
  try{
   const res=await fetch('/api/etherscan/verify-indexio-pay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,address:record.contractAddress,transactionHash:record.transactionHash,treasury:record.treasury,guid:record.guid})});
   const data=await res.json().catch(()=>({error:'BaseScan returned an unreadable response.'}));
   if(!res.ok)throw Error(data.error||'Verification could not be submitted.');
   const status:RecordState['verification']=data.verified?'verified':data.pending?'pending':'failed';
   setRecord(r=>({...r,guid:data.guid||r.guid,verification:status}));
   if(data.error)setError(data.error);else setNotice(data.message||'Verification updated.');
  }catch(e){setError(errText(e))}finally{setBusy('')}
 }
 async function copy(text:string){try{await navigator.clipboard.writeText(text);setNotice('Copied to clipboard.')}catch{setError('Copy unavailable. Open this page over HTTPS and allow clipboard access.')}}
 function newDeployment(){if(!window.confirm('Start a separate deployment? This clears only the locally saved record and does not remove the deployed contract. Save its address and transaction first.'))return;setRecord(EMPTY);setApproved(false);setNotice('Local record cleared. The existing contract remains on Base.');setError('')}

 return <main className="payShell">
  <header className="payHero"><span className="payLabel">INDEXIO · PAY ROUTER V1</span><h1>USDC payments,<br/><em>simplified.</em></h1><p>Deploy a fixed-fee payment contract on Base, then verify the exact source code on BaseScan. Your wallet signs deployment; the app never asks for a private key.</p><div className="payChips"><span>BASE MAINNET · 8453</span><span>USDC</span><span>IMMUTABLE FEES</span></div></header>
  <div className="payStats"><div><small>ROUTING FEE</small><strong>0.10%</strong><span>Deducted from amount sent</span></div><div><small>MAXIMUM FEE</small><strong>$20</strong><span>Per transfer · USDC</span></div><div><small>OWNER ACCESS</small><strong>None</strong><span>No upgrades or fee changes</span></div></div>
  <section className="payCard">
   <div className="paySectionHead"><span>01</span><div><h2>Connect to Base</h2><p>Use the wallet that will pay the network deployment gas.</p></div></div>
   <div className="payWallet"><div><small>CONNECTED WALLET</small><strong>{isConnected&&address?short(address):'Not connected'}</strong><span>{isConnected?(chainId===base.id?'Base Mainnet connected':'Switch network to Base Mainnet'):'MetaMask or other injected wallet'}</span></div>
    {!isConnected?<button type="button" onClick={connect} disabled={!!busy}>Connect wallet</button>:chainId!==base.id?<button type="button" onClick={switchBase} disabled={!!busy}>Switch to Base</button>:<span className="payConnected">● Ready</span>}
   </div>
  </section>
  <section className="payCard">
   <div className="paySectionHead"><span>02</span><div><h2>Set the fee treasury</h2><p>The treasury receives fees immediately and is fixed permanently at deployment.</p></div></div>
   <label className="payInputLabel" htmlFor="pay-treasury">TREASURY WALLET ADDRESS</label>
   <input id="pay-treasury" className="payInput" spellCheck={false} autoComplete="off" placeholder="0x… fee recipient on Base" value={record.treasury} onChange={e=>{setRecord(r=>({...r,treasury:e.target.value}));setApproved(false)}} disabled={Boolean(record.transactionHash)||!!busy}/>
   <p className="payHint">Use a treasury address you control and double-check every character. It cannot be changed afterward. The treasury address cannot send payments through this router or receive payments as a recipient.</p>
   {record.treasury&&!treasuryValid&&<div className="payWarning">Enter a valid wallet address (not the Base USDC contract).</div>}
   {treasuryValid&&address&&getAddress(record.treasury)===getAddress(address)&&!record.transactionHash&&<div className="payWarning">This treasury matches your connected wallet. That wallet will not be allowed to use this router to send payments.</div>}
   <div className="payPreview"><span>EXAMPLE PAYMENT BREAKDOWN</span>{feeExamples.map(row=><div key={row.sent}><strong>${row.sent.toLocaleString('en-US',{minimumFractionDigits:2})} sent</strong><span>${row.received.toLocaleString('en-US',{minimumFractionDigits:2})} to recipient · ${row.fee.toFixed(2)} fee</span></div>)}</div>
   {!record.transactionHash&&<label className="payApprove"><input type="checkbox" checked={approved} onChange={e=>setApproved(e.target.checked)}/><span>I verified the permanent treasury address and understand deployment costs Base ETH. The contract cannot be upgraded, paused, or have its fee changed.</span></label>}
   {!record.transactionHash&&<button type="button" className="payPrimary" disabled={!canDeploy} onClick={deploy}>{busy==='deploy'?'Working with wallet…':'Deploy Pay Router on Base ↗'}</button>}
   <p className="payTiny">Solidity {indexioPayCompiler} · Optimizer 200 · Cancun EVM · No deployment service holds funds.</p>
  </section>
  <section className="payCard">
   <div className="paySectionHead"><span>03</span><div><h2>Confirm deployment</h2><p>The address and transaction are saved in this browser so you can resume after a reload.</p></div></div>
   {record.transactionHash?<div className="payRecord">
    <div><span>TRANSACTION</span><code>{record.transactionHash}</code><a href={`${EXPLORER}/tx/${record.transactionHash}`} target="_blank" rel="noreferrer">View on BaseScan ↗</a></div>
    <div><span>CONTRACT</span><code>{record.contractAddress||'Awaiting confirmation — refresh to check'}</code>{record.contractAddress&&<a href={`${EXPLORER}/address/${record.contractAddress}#code`} target="_blank" rel="noreferrer">View contract ↗</a>}</div>
    <button className="payOutline" type="button" disabled={!!busy} onClick={()=>refresh()}>{busy==='refresh'?'Checking Base…':'↻ Refresh deployment'}</button>
   </div>:<div className="payEmpty">No Pay Router deployment recorded yet. Deploy above, or restore an existing deployment below.</div>}
   {!record.transactionHash&&<div className="payRestore"><label className="payInputLabel" htmlFor="pay-restore">ALREADY DEPLOYED? RESTORE BY BASE TRANSACTION HASH</label><div><input id="pay-restore" className="payInput" placeholder="0x… deployment transaction" value={restoreHash} onChange={e=>setRestoreHash(e.target.value.trim())}/><button type="button" className="payOutline" disabled={!restoreHash||!!busy} onClick={()=>refresh(restoreHash)}>Restore</button></div></div>}
  </section>
  <section className="payCard">
   <div className="paySectionHead"><span>04</span><div><h2>Verify on BaseScan</h2><p>Uses the Etherscan V2 API, with Base chain ID 8453 and the exact source and constructor arguments used to deploy.</p></div></div>
   <div className="payVerify"><div><small>SOURCE CODE STATUS</small><strong className={record.verification==='verified'?'paySuccess':''}>{record.verification==='verified'?'✓ Verified on BaseScan':record.verification==='pending'?'Verification processing':record.verification==='failed'?'Not yet verified':'Not yet verified'}</strong></div>
    <span>{record.contractAddress?short(record.contractAddress):'Deploy first'}</span></div>
   <div className="payActions"><button className="payPrimary" type="button" disabled={!canVerify||record.verification==='verified'||Boolean(record.guid&&record.verification==='pending')} onClick={()=>verify('verify')}>{busy==='verify'?'Submitting source…':record.verification==='verified'?'Source verified ✓':'Submit source for verification'}</button><button className="payOutline" type="button" disabled={!canVerify} onClick={()=>verify('check')}>{busy==='check'?'Checking…':'Check verification'}</button></div>
   {record.guid&&<div className="payGuid">Verification request ID: <code>{record.guid}</code></div>}
   {record.contractAddress&&<a className="payTextLink" href={`${EXPLORER}/address/${record.contractAddress}#code`} target="_blank" rel="noreferrer">Open contract code on BaseScan ↗</a>}
   <p className="payTiny">For automated verification, set <code>ETHERSCAN_API_KEY</code> in Vercel's server environment. Never use a NEXT_PUBLIC_ prefix for this key. If verification fails, reuse this address rather than deploying again.</p>
  </section>
  {record.contractAddress&&<section className="payCard">
   <div className="paySectionHead"><span>05</span><div><h2>Integration details</h2><p>Save these values for connecting the new Pay Router to the Indexio app and payment activity indexer.</p></div></div>
   <pre className="payIntegration">{JSON.stringify(integration,null,2)}</pre>
   <button type="button" className="payOutline" onClick={()=>copy(JSON.stringify(integration,null,2))}>Copy integration JSON</button>
   <button type="button" className="payNew" onClick={newDeployment}>Start another deployment (clear saved record)</button>
  </section>}
  {(error||notice)&&<div role="status" className={`payNotice ${error?'payError':''}`}>{error||notice}</div>}
  <footer className="payFooter">Contract source is included in the deployment package. Live mainnet deployment and BaseScan verification require your connected wallet, Base network access, and an Etherscan API key on the server.</footer>
 </main>
}
