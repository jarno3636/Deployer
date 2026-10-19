import Link from 'next/link';

export default function Page(){
 return <main className="launchHome">
  <div className="launchTop">
   <span className="launchLogo">i</span>
   <div><span className="launchBrand">INDEXIO</span><span className="launchCaption">Contract deployment center</span></div>
   <span className="launchNetwork"><span /> BASE MAINNET</span>
  </div>
  <div className="launchHero">
   <div className="launchEyebrow">DEPLOY · VERIFY · RECORD</div>
   <h1>Deploy with clarity.</h1>
   <p>Choose a contract, approve deployment in your wallet, and publish its source code to BaseScan. Keep the transaction and contract address together for your records.</p>
  </div>
  <section className="launchFeatured">
   <div className="launchFeaturedText"><span className="launchKicker">NEW · USDC PAYMENTS</span><h2>Indexio Pay Router</h2>
    <p>Simple, direct USDC payments on Base with a fixed <strong>0.1% fee, capped at $20</strong>. The fee comes out of the amount sent. No owner controls or upgradeable contract.</p>
    <div className="launchFacts"><span>0.1% fee</span><span>$20 maximum</span><span>Native Base USDC</span></div>
    <Link href="/pay" className="launchAction">Deploy Pay Router <span aria-hidden>↗</span></Link>
   </div>
   <div className="launchExample"><span>PAYMENT PREVIEW</span><strong>$1,000.00</strong><div><span>Recipient gets</span><b>$999.00</b></div><div><span>Protocol fee</span><b>$1.00</b></div><small>Fixed in contract · USDC</small></div>
  </section>
  <section className="launchSection"><div className="launchSectionHead"><h2>Other deployment tools</h2><p>The existing Indexio suite remains available without changes.</p></div>
   <div className="launchGrid">
    <Link href="/indexio/v3/v34" className="launchTile"><span>NEW · GOVERNANCE</span><h3>Indexio V3.4</h3><p>New suite with post-vote fresh-plan authorization, resumable deployment and existing registry.</p><b>Open V3.4 suite ↗</b></Link>
    <Link href="/indexio/v3/v338" className="launchTile"><span>01 · PROTOCOL</span><h3>Indexio V3.3.8</h3><p>Deploy and manage the index factory, routers, adapters and vaults.</p><b>Open V3.3.8 suite ↗</b></Link>
    <Link href="/indexio/v3/adaptive-buy" className="launchTile"><span>02 · TRADING</span><h3>Adaptive Buy</h3><p>Set up and verify the V3.3.8 adaptive buy extension.</p><b>Open deployment ↗</b></Link>
    <Link href="/indexio/v3/route-test" className="launchTile"><span>03 · DIAGNOSTICS</span><h3>Route testing</h3><p>Check available liquidity and trading routes before enabling them.</p><b>Open route tests ↗</b></Link>
   </div>
  </section>
  <footer className="launchFooter">Base Mainnet · Chain ID 8453 · Contract deployment is irreversible. Review every transaction before signing.</footer>
 </main>
}
