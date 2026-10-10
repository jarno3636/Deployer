import Link from 'next/link';
import {IndexioV32Deployer} from '../../../components/IndexioV32Deployer';
export default function Page(){return <><div style={{maxWidth:1100,margin:'12px auto',padding:'0 16px',display:'flex',flexWrap:'wrap',gap:12}}><Link href="/indexio/v3/route-test" style={{display:'inline-block',padding:'10px 16px',borderRadius:8,border:'1px solid #64748b'}}>Test LI.FI routes ↗</Link><Link href="/indexio/v3/adaptive-buy" style={{display:'inline-block',padding:'10px 16px',borderRadius:8,border:'1px solid #64748b'}}>Adaptive Buy add-on ↗</Link></div><IndexioV32Deployer/></>}
