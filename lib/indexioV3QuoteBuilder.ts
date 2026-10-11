import { encodeAbiParameters, getAddress, isAddress, keccak256, type Address } from 'viem';
import { checkV3BuyFit, type V3BuyFitLeg } from './indexioV3BuyFit';
import { baseClient,erc20Abi } from './assetBackedIndexes';
import { INDEXIO_V3_ADAPTER,INDEXIO_V3_ALLOWANCE_HOLDER,INDEXIO_V3_EXECUTION_ROUTER,INDEXIO_V3_FACTORY,INDEXIO_V3_LIFI_ADAPTER,INDEXIO_V3_USDC,factoryV3Abi,shareTokenV3Abi,vaultV3Abi } from './indexioV3';
const ZERO='0x0000000000000000000000000000000000000000' as Address;
const lifiAbi=[{type:'function',name:'allowedTarget',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'bool'}]},{type:'function',name:'allowedSpender',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'bool'}]},{type:'function',name:'allowedSelector',stateMutability:'view',inputs:[{type:'bytes4'}],outputs:[{type:'bool'}]},{type:'function',name:'allowedTargetSelector',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'bool'}]}] as const;
function n(v:unknown,name:string){const x=BigInt(String(v||'0'));if(x<=0n)throw Error(`${name} must be greater than zero.`);return x}
function isB20(token:Address){return token.toLowerCase().startsWith('0xb200000000000000000000')}
async function tokenLabel(token:Address){try{const c=baseClient();const symbol=String(await c.readContract({address:token,abi:erc20Abi,functionName:'symbol'}));return symbol||`${token.slice(0,6)}…${token.slice(-4)}`}catch{return `${token.slice(0,6)}…${token.slice(-4)}`}}
async function zeroX(sellToken:Address,buyToken:Address,sellAmount:bigint){const key=process.env.ZERO_X_API_KEY||process.env.ZEROX_API_KEY;if(!key)throw Error('Index trading is temporarily unavailable.');const q=new URLSearchParams({chainId:'8453',sellToken,buyToken,sellAmount:String(sellAmount),taker:INDEXIO_V3_ADAPTER,recipient:INDEXIO_V3_EXECUTION_ROUTER,slippageBps:'100'});const r=await fetch(`https://api.0x.org/swap/allowance-holder/quote?${q}`,{headers:{'0x-api-key':key,'0x-version':'v2'},cache:'no-store',signal:AbortSignal.timeout(12000)});const j=await r.json().catch(()=>null);if(!r.ok||!j?.liquidityAvailable){const label=await tokenLabel(sellToken.toLowerCase()===INDEXIO_V3_USDC.toLowerCase()?buyToken:sellToken);throw Error(`A protected 0x route is not available for ${label}.`);}if(String(j.transaction?.to).toLowerCase()!==INDEXIO_V3_ALLOWANCE_HOLDER.toLowerCase()||String(j.allowanceTarget||j.issues?.allowance?.spender||INDEXIO_V3_ALLOWANCE_HOLDER).toLowerCase()!==INDEXIO_V3_ALLOWANCE_HOLDER.toLowerCase())throw Error('0x returned an unexpected execution contract.');if(!j.transaction?.data||!j.buyAmount||!j.minBuyAmount)throw Error('The protected 0x quote was incomplete.');return{adapter:INDEXIO_V3_ADAPTER,amountIn:sellAmount,quotedAmountOut:BigInt(j.buyAmount),minAmountOut:BigInt(j.minBuyAmount),routeData:j.transaction.data as `0x${string}`};}
async function lifi(sellToken:Address,buyToken:Address,sellAmount:bigint){const label=await tokenLabel(sellToken.toLowerCase()===INDEXIO_V3_USDC.toLowerCase()?buyToken:sellToken);const q=new URLSearchParams({fromChain:'8453',toChain:'8453',fromToken:sellToken,toToken:buyToken,fromAmount:String(sellAmount),fromAddress:INDEXIO_V3_LIFI_ADAPTER,toAddress:INDEXIO_V3_EXECUTION_ROUTER,slippage:'0.005',maxPriceImpact:'0.08',denyBridges:'all',skipSimulation:'true',integrator:'indexio'});const headers:Record<string,string>={accept:'application/json'};if(process.env.LIFI_API_KEY)headers['x-lifi-api-key']=process.env.LIFI_API_KEY;const r=await fetch(`https://li.quest/v1/quote?${q}`,{headers,cache:'no-store',signal:AbortSignal.timeout(15000)});const j=await r.json().catch(()=>null);if(!r.ok){throw Error(String(j?.message||j?.error?.message||j?.error||`A protected LI.FI route is not available for ${label}.`))}const target=String(j?.transactionRequest?.to||'');const spender=String(j?.estimate?.approvalAddress||'');const data=String(j?.transactionRequest?.data||'');const quoted=String(j?.estimate?.toAmount||'');const min=String(j?.estimate?.toAmountMin||'');if(!isAddress(target)||!isAddress(spender)||!/^0x[0-9a-fA-F]{8,}$/.test(data)||!/^[0-9]+$/.test(quoted)||!/^[0-9]+$/.test(min))throw Error(`LI.FI returned an incomplete ${label} route.`);const t=getAddress(target),sp=getAddress(spender),selector=data.slice(0,10) as `0x${string}`;const c=baseClient();const targetSelectorKey=keccak256(encodeAbiParameters([{type:'address'},{type:'bytes4'}],[t,selector]));const [targetOk,spenderOk,selectorOk,pairOk]=await Promise.all([c.readContract({address:INDEXIO_V3_LIFI_ADAPTER,abi:lifiAbi,functionName:'allowedTarget',args:[t]}),c.readContract({address:INDEXIO_V3_LIFI_ADAPTER,abi:lifiAbi,functionName:'allowedSpender',args:[sp]}),c.readContract({address:INDEXIO_V3_LIFI_ADAPTER,abi:lifiAbi,functionName:'allowedSelector',args:[selector]}),c.readContract({address:INDEXIO_V3_LIFI_ADAPTER,abi:lifiAbi,functionName:'allowedTargetSelector',args:[targetSelectorKey]})]);if(!targetOk||!spenderOk||!selectorOk||!pairOk)throw Error(`LI.FI found a ${label} route, but its execution infrastructure is not yet approved by Indexio.`);return{adapter:INDEXIO_V3_LIFI_ADAPTER,amountIn:sellAmount,quotedAmountOut:BigInt(quoted),minAmountOut:BigInt(min),routeData:encodeAbiParameters([{type:'address'},{type:'address'},{type:'bytes'}],[t,sp,data as `0x${string}`])};}
async function protectedRoute(sellToken:Address,buyToken:Address,sellAmount:bigint){const stock=isB20(sellToken)||isB20(buyToken);if(stock)return lifi(sellToken,buyToken,sellAmount);try{return await zeroX(sellToken,buyToken,sellAmount)}catch{return lifi(sellToken,buyToken,sellAmount)}}
function usdcText(v:bigint){return (Number(v)/1_000_000).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
async function routeWithIndexContext(asset:Address,part:bigint,weightBps:bigint,mode:'seed'|'buy'){try{return await protectedRoute(INDEXIO_V3_USDC,asset,part)}catch(original:any){const label=await tokenLabel(asset);let firstRoutable:bigint|undefined;const probes=[2_000_000n,3_000_000n,5_000_000n,7_500_000n,10_000_000n,15_000_000n,25_000_000n].filter(x=>x>part);for(const probe of probes){try{await protectedRoute(INDEXIO_V3_USDC,asset,probe);firstRoutable=probe;break}catch{}}const prefix=`No LI.FI route for ${label} at ${usdcText(part)} USDC (${Number(weightBps)/100}% of this index).`;if(firstRoutable){const implied=(firstRoutable*10000n+weightBps-1n)/weightBps;throw Error(`${prefix} ${label} first quoted at about ${usdcText(firstRoutable)} USDC in this check, so try an index investment of at least about ${usdcText(implied)} USDC.`)}const detail=String(original?.message||'No route was returned.');throw Error(`${prefix} No route was found for ${label} even when checked up to 25.00 USDC. ${detail}`)}}

/** Validate both entry and exit routes at the proposed minimum seed size.
 * A buy quote alone is not proof that investors can exit the asset.
 * These checks are indicative, not a guarantee of execution or future liquidity.
 */
export async function checkV3CompositionRoutes(assets: Address[], weightsBps: number[]) {
 if(assets.length!==weightsBps.length||assets.length<2)throw Error('Choose at least two investments before checking routes.');
 if(weightsBps.some(w=>!Number.isInteger(w)||w<=0)||weightsBps.reduce((a,b)=>a+b,0)!==10000)throw Error('Index allocations must total 100%.');
 const protocolSeed=25_000_000n;
 const results=await Promise.all(assets.map(async(asset,i)=>{
  const weight=BigInt(weightsBps[i]);const label=await tokenLabel(asset);
  if(asset.toLowerCase()===INDEXIO_V3_USDC.toLowerCase())return{asset,label,routable:true,minimumIndexUsdc:25,checkedToUsdc:0,recoveryBps:10000,warning:null,reason:null};
  const weighted=(protocolSeed*weight)/10000n;
  const candidates=[weighted,2_000_000n,3_000_000n,5_000_000n,7_500_000n,10_000_000n,15_000_000n,25_000_000n]
   .filter(x=>x>0n).sort((a,b)=>a<b?-1:a>b?1:0).filter((x,j,a)=>j===0||x!==a[j-1]);
  let last='No protected buy and sell routes were returned.';
  for(const amount of candidates){
   try{
    const buy=await protectedRoute(INDEXIO_V3_USDC,asset,amount);
    if(buy.minAmountOut<=0n)throw Error('Buy route has no minimum output.');
    // Use conservative buy output for the exit check, not the optimistic quote.
    const sell=await protectedRoute(asset,INDEXIO_V3_USDC,buy.minAmountOut);
    if(sell.minAmountOut<=0n)throw Error('Sell route has no minimum USDC output.');
    const recoveryBps=Number(sell.minAmountOut*10000n/amount);
    if(recoveryBps<9000)throw Error(`Estimated round-trip minimum recovery is ${(recoveryBps/100).toFixed(1)}%. Exit liquidity is too weak at this size.`);
    const implied=(amount*10000n+weight-1n)/weight;
    return{asset,label,routable:true,minimumIndexUsdc:Number(implied)/1_000_000,checkedToUsdc:Number(amount)/1_000_000,recoveryBps,warning:recoveryBps<9700?'Material round-trip loss; review liquidity before investing.':null,reason:null};
   }catch(e:any){last=String(e?.message||last)}
  }
  return{asset,label,routable:false,minimumIndexUsdc:null,checkedToUsdc:25,recoveryBps:null,warning:null,reason:last};
 }));
 const blocked=results.filter(x=>!x.routable);
 const warnings=results.filter(x=>x.warning);
 const suggestedMinimumUsdc=Math.max(25,...results.map(x=>x.minimumIndexUsdc||0));
 return{ok:blocked.length===0,protocolMinimumUsdc:25,suggestedMinimumUsdc,results,blocked,warnings,disclaimer:'Route checks are indicative and may change before execution. Transfer taxes and market impact can reduce actual proceeds.'};
}


export async function checkV3AssetRoundTrip(asset: Address, grossUsdc = 25_000_000n) {
  if (!isAddress(asset)) throw Error('Invalid asset address.');
  if (asset.toLowerCase() === INDEXIO_V3_USDC.toLowerCase()) {
    return { ok:true, asset, amountUsdc:Number(grossUsdc)/1_000_000, buy:{adapter:'direct',quotedAmountOut:String(grossUsdc)}, sell:{adapter:'direct',quotedAmountOut:String(grossUsdc)} };
  }
  const buy = await protectedRoute(INDEXIO_V3_USDC, asset, grossUsdc);
  if (buy.quotedAmountOut <= 0n) throw Error('The buy route returned no asset output.');
  const sell = await protectedRoute(asset, INDEXIO_V3_USDC, buy.quotedAmountOut);
  const recoveryBps = grossUsdc > 0n ? Number(sell.quotedAmountOut * 10000n / grossUsdc) : 0;
  const minimumRecoveryBps = grossUsdc > 0n ? Number(sell.minAmountOut * 10000n / grossUsdc) : 0;
  const liquidityWarning = recoveryBps < 9000 ? 'Severe round-trip loss at the tested size. Do not activate without reviewing executable sell liquidity.' : recoveryBps < 9700 ? 'Material round-trip loss at the tested size. Review sell liquidity and price impact.' : null;
  const adapterLabel = (address: Address) => address.toLowerCase() === INDEXIO_V3_LIFI_ADAPTER.toLowerCase() ? 'LI.FI' : address.toLowerCase() === INDEXIO_V3_ADAPTER.toLowerCase() ? '0x' : 'Protected route';
  return {
    ok:liquidityWarning === null,
    liquidityWarning,
    recoveryBps,
    minimumRecoveryBps,
    asset,
    amountUsdc:Number(grossUsdc)/1_000_000,
    buy:{adapter:adapterLabel(buy.adapter),quotedAmountOut:String(buy.quotedAmountOut),minimumAmountOut:String(buy.minAmountOut)},
    sell:{adapter:adapterLabel(sell.adapter),quotedAmountOut:String(sell.quotedAmountOut),minimumAmountOut:String(sell.minAmountOut)},
  };
}

export async function buildV3Quote(body:Record<string,unknown>){const mode=String(body.mode||'');const vault=String(body.vault||'') as Address;const wallet=String(body.wallet||'') as Address;if(!['seed','buy','sell'].includes(mode)||!isAddress(vault)||!isAddress(wallet))throw Error('Invalid index request.');const c=baseClient();if(!await c.readContract({address:INDEXIO_V3_FACTORY,abi:factoryV3Abi,functionName:'isVault',args:[vault]}))throw Error('This is not a current Indexio index.');const [assets,weights,token,seeded,creatorFee]=await Promise.all([c.readContract({address:vault,abi:vaultV3Abi,functionName:'assets'}),c.readContract({address:vault,abi:vaultV3Abi,functionName:'weights'}),c.readContract({address:vault,abi:vaultV3Abi,functionName:'shareToken'}),c.readContract({address:vault,abi:vaultV3Abi,functionName:'seeded'}),c.readContract({address:vault,abi:vaultV3Abi,functionName:'creatorFeeBps'})]);
 if (mode === 'sell') {
  const shares = n(body.shares, 'Shares');
  const [supply, walletShares, ...balances] = await Promise.all([
   c.readContract({address:token,abi:shareTokenV3Abi,functionName:'totalSupply'}),
   c.readContract({address:token,abi:shareTokenV3Abi,functionName:'balanceOf',args:[wallet]}),
   ...assets.map(a=>c.readContract({address:a,abi:erc20Abi,functionName:'balanceOf',args:[vault]})),
  ]);
  if(shares>walletShares)throw Error('You do not have enough shares.');
  if(supply<=0n)throw Error('This index has no redeemable shares.');
  const parts = assets.map((asset,i)=>{
   const gross=balances[i]*shares/supply;
   const protocolFee=gross*100n/10000n;
   const creatorCut=gross*BigInt(creatorFee)/10000n;
   const net=gross-protocolFee-creatorCut;
   if(net<=0n)throw Error(`A redemption asset (${asset}) rounds to zero. Sell more shares or withdraw underlying assets.`);
   return {asset,net};
  });
  const legs: Array<Awaited<ReturnType<typeof protectedRoute>>> = new Array(parts.length);
  // Keep each leg's index stable and avoid the many-sequential-API-call expiry
  // problem. Limit the number of simultaneous external quote requests to three.
  for(let start=0;start<parts.length;start+=3){
   const end=Math.min(start+3,parts.length);
   await Promise.all(parts.slice(start,end).map(async({asset,net},offset)=>{
    const i=start+offset;
    if(asset.toLowerCase()===INDEXIO_V3_USDC.toLowerCase()){
     legs[i]={adapter:ZERO,amountIn:net,quotedAmountOut:net,minAmountOut:net,routeData:'0x'};
     return;
    }
    try{legs[i]=await protectedRoute(asset,INDEXIO_V3_USDC,net)}
    catch(error){
     const label=await tokenLabel(asset);
     const detail=String(error instanceof Error?error.message:'No executable route').replace(/0x[0-9a-fA-F]{64,}/g,'[redacted]').slice(0,220);
     throw Error(`Sell leg ${i+1}/${parts.length} (${label}, ${asset}) cannot be quoted by the original execution router: ${detail}`);
    }
   }));
  }
  const min=legs.reduce((sum,leg)=>sum+leg.minAmountOut,0n);
  const quoted=legs.reduce((sum,leg)=>sum+leg.quotedAmountOut,0n);
  if(min<=0n||quoted<=0n)throw Error('This redemption is too small to return USDC. Sell more shares or withdraw underlying assets.');
  const policies=await Promise.all(assets.map(async asset=>{
   try { return Number(await c.readContract({address:vault,abi:vaultV3Abi,functionName:'expectedReceiveBps',args:[asset]})); }
   catch { return null; }
  }));
  return {mode,shares:String(shares),
   legs:legs.map(x=>({...x,amountIn:String(x.amountIn),quotedAmountOut:String(x.quotedAmountOut),minAmountOut:String(x.minAmountOut)})),
   minSettlementOut:String(min),projectedSettlementOut:String(quoted),
   transferPolicyWarnings:assets.flatMap((asset,i)=>policies[i]!==null&&policies[i]!<10000
    ?[{asset,configuredMaxTransferLossBps:10000-policies[i]!,note:'Configured transfer-loss allowance is NOT an actual measured sell tax or an adapter-compatibility guarantee.'}]:[]),
  };
 }

 // Regular purchases must allocate the ENTIRE settlementAmountIn to the router's legs.
 // The router checks each amountIn against the full USDC amount and the vault
 // subsequently accounts for protocol/creator fees when minting shares.
 // Keep this branch separate: initial seeding and selling retain their existing logic.
 if (mode === 'buy') {
  const amount = n(body.settlementAmount, 'Amount');
  if (!seeded) throw Error('This index is waiting for its creator’s first investment.');
  if (!assets.length || weights.length !== assets.length ||
      weights.reduce((total, weight) => total + BigInt(weight), 0n) !== 10_000n ||
      weights.some(weight => BigInt(weight) <= 0n)) {
   throw Error('The index has an invalid allocation. Refresh the index before investing.');
  }
  const protocolFee = amount * 100n / 10_000n;
  const creatorCut = amount * BigInt(creatorFee) / 10_000n;
  const investable = amount - protocolFee - creatorCut;
  if (investable <= 0n) throw Error('Amount is too small after the Indexio and creator fees.');

  const legs = [];
  let allocated = 0n;
  for (let i = 0; i < assets.length; i++) {
   // Match the V3.3.8 router's buyIndex expected-weight calculation exactly.
   // Last leg gets the remainder so rounding cannot strand a USDC micro-unit.
   const part = i === assets.length - 1
    ? amount - allocated
    : amount * BigInt(weights[i]) / 10_000n;
   if (part <= 0n) throw Error('Increase the USDC amount so every holding can receive an allocation.');
   allocated += part;
   if (assets[i].toLowerCase() === INDEXIO_V3_USDC.toLowerCase()) {
    legs.push({adapter: ZERO, amountIn: part, quotedAmountOut: part, minAmountOut: part, routeData: '0x'});
   } else {
    legs.push(await routeWithIndexContext(assets[i], part, BigInt(weights[i]), 'buy'));
   }
  }
  if (allocated !== amount || legs.length !== assets.length ||
      legs.some((leg, i) => leg.amountIn !== (
       i === assets.length - 1
        ? amount - weights.slice(0, -1).reduce((sum, weight) => sum + amount * BigInt(weight) / 10_000n, 0n)
        : amount * BigInt(weights[i]) / 10_000n))) {
   throw Error('The investment allocation could not be verified. No transaction was prepared.');
  }

  // V3.3.8's fixed USDC weights and the vault's live proportional-balance
  // requirement are DIFFERENT constraints. Check their intersection before
  // a wallet approval or transaction is requested. This is read-only.
  const [supply, fitState] = await Promise.all([
   c.readContract({address: token, abi: shareTokenV3Abi, functionName: 'totalSupply'}),
   Promise.all(assets.map(async asset => {
    const [vaultBalance, receiveBps] = await Promise.all([
     c.readContract({address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [vault]}),
     c.readContract({address: vault, abi: vaultV3Abi, functionName: 'expectedReceiveBps', args: [asset]}),
    ]);
    return { vaultBalance: BigInt(vaultBalance), receiveBps: Number(receiveBps) };
   })),
  ]);
  const legsForFit: V3BuyFitLeg[] = legs.map((leg, i) => ({
   gross: leg.quotedAmountOut,
   vaultBalance: fitState[i].vaultBalance,
   receiveBps: fitState[i].receiveBps,
  }));
  const fit = checkV3BuyFit(legsForFit, BigInt(supply), Number(creatorFee));
  if (!fit.ok) throw Error(`${fit.reason} No purchase transaction was prepared. The index may need a rebalance or a different executable swap route.`);

  // Tighten the router's regular-buy output floors to limit unforeseen
  // imbalance from price movement. The embedded 0x/LI.FI swap still has its
  // own slippage check. A changed quote can always fail; never auto-retry.
  for (let i = 0; i < legs.length; i++) {
   if (legs[i].adapter === ZERO) continue;
   const shortfallBps = fitState[i].receiveBps < 10000 ? 30n : 12n;
   const tighterFloor = (legs[i].quotedAmountOut * (10_000n - shortfallBps) + 9_999n) / 10_000n;
   if (tighterFloor > legs[i].minAmountOut) legs[i].minAmountOut = tighterFloor;
  }
  return {
   mode,
   settlementAmount: String(amount),
   protocolFee: String(protocolFee),
   creatorFee: String(creatorCut),
   investableAmount: String(investable),
   swapAllocationAmount: String(allocated),
   legs: legs.map(leg => ({...leg, amountIn: String(leg.amountIn), quotedAmountOut: String(leg.quotedAmountOut), minAmountOut: String(leg.minAmountOut)})),
  };
 }

 // V3.3.8 seedIndex checks each leg against the GROSS settlementAmountIn,
 // not the after-fee amount. The vault takes its protocol/creator fees out of
 // the purchased assets inside vault.seed(), after the router has bought them.
 // Never subtract those fees twice by using "investable" to size seed swaps.
 const amount = n(body.settlementAmount, 'Amount');
 if (mode !== 'seed') throw Error('Unsupported transaction mode.');
 if (amount < 25_000_000n) throw Error('The first investment must be at least 25 USDC.');
 if (seeded) throw Error('This index already has its first investment.');
 if (!assets.length || assets.length !== weights.length ||
     weights.some(weight => BigInt(weight) <= 0n) ||
     weights.reduce((sum, weight) => sum + BigInt(weight), 0n) !== 10_000n) {
  throw Error('This index has an invalid allocation. Refresh the index before making the first investment.');
 }
 const protocolFee = amount * 100n / 10_000n;
 const creatorCut = amount * BigInt(creatorFee) / 10_000n;
 const investable = amount - protocolFee - creatorCut;
 if (investable <= 0n) throw Error('Amount is too small after the Indexio and creator fees.');
 const legs = [];
 let allocated = 0n;
 for (let i = 0; i < assets.length; i++) {
  // Match ExecutionRouterV3.seedIndex exactly, including the last-leg remainder.
  const part = i === assets.length - 1
   ? amount - allocated
   : amount * BigInt(weights[i]) / 10_000n;
  if (part <= 0n) throw Error('Increase the USDC amount so every holding can receive an allocation.');
  allocated += part;
  if (assets[i].toLowerCase() === INDEXIO_V3_USDC.toLowerCase()) {
   legs.push({adapter: ZERO, amountIn: part, quotedAmountOut: part, minAmountOut: part, routeData: '0x'});
  } else {
   legs.push(await routeWithIndexContext(assets[i], part, BigInt(weights[i]), 'seed'));
  }
 }
 // Fail at quote time instead of inviting a wallet approval for a seed that
 // would inevitably revert with "weight" in ExecutionRouterV3.seedIndex.
 let routerAllocated = 0n;
 if (legs.length !== assets.length || legs.some((leg, i) => {
  const required = i === assets.length - 1
   ? amount - routerAllocated
   : amount * BigInt(weights[i]) / 10_000n;
  routerAllocated += required;
  return leg.amountIn !== required || required <= 0n;
 }) || allocated !== amount || routerAllocated !== amount) {
  throw Error('First-investment allocation does not match the vault weights. No transaction was prepared.');
 }
 return {
  mode, settlementAmount: String(amount),
  protocolFee: String(protocolFee), creatorFee: String(creatorCut),
  investableAmount: String(investable), swapAllocationAmount: String(allocated),
  legs: legs.map(x => ({...x, amountIn: String(x.amountIn), quotedAmountOut: String(x.quotedAmountOut), minAmountOut: String(x.minAmountOut)})),
 };
}
