import Link from 'next/link';
import { IndexioPayDeployer } from '../../components/IndexioPayDeployer';
export default function Page(){return <>
 <div className="payPageNav"><Link href="/">← Deployment home</Link><span>PAY ROUTER · BASE</span></div>
 <IndexioPayDeployer/>
</>}
