import Link from 'next/link';
import { IndexioV338Deployer } from '../../../../components/IndexioV338Deployer';
export default function Page() {
 return <>
  <div style={{maxWidth:760,margin:'14px auto 0',padding:'0 14px'}}><Link href="/" style={{color:'#8eeaff',fontSize:13}}>← Deployment home</Link></div>
  <IndexioV338Deployer />
 </>;
}
