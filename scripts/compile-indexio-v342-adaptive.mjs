import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import {keccak256} from 'viem';

const root=process.cwd();
const sources={};
const importRegex=/import\s+(?:[^"']*?from\s+)?["']([^"']+)["']\s*;/g;
const files=[
  'contracts/indexio-v3/IndexioProportionalBuyRouterV342.sol',
  'contracts/indexio-v3/IndexioRestrictedSwapAdapterV3.sol',
  'contracts/indexio-v3/IndexioLifiSwapAdapterV3.sol'
];
function resolve(origin, ref) {
  if(ref.startsWith('@')) return ref;
  return ref.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(origin), ref)):ref;
}
function add(file){
  if(sources[file])return;
  const location=file.startsWith('@openzeppelin/')?path.join(root,'node_modules',file):path.join(root,file);
  if(!fs.existsSync(location))throw Error(`Missing ${file}: run npm ci first`);
  const content=fs.readFileSync(location,'utf8');
  sources[file]={content};
  for(const m of content.matchAll(importRegex))add(resolve(file,m[1]));
}
for(const file of files)add(file);
const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:500},viaIR:true,outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','metadata']}}}};
const output=JSON.parse(solc.compile(JSON.stringify(input)));
for(const warning of output.errors||[]){(warning.severity==='error'?console.error:console.warn)(warning.formattedMessage||warning.message);}
if((output.errors||[]).some(e=>e.severity==='error'))process.exit(1);
const contractMap={
  router:['contracts/indexio-v3/IndexioProportionalBuyRouterV342.sol','IndexioProportionalBuyRouterV342'],
  zeroX:['contracts/indexio-v3/IndexioRestrictedSwapAdapterV3.sol','IndexioRestrictedSwapAdapterV3'],
  lifi:['contracts/indexio-v3/IndexioLifiSwapAdapterV3.sol','IndexioLifiSwapAdapterV3']
};
const artifacts={};let failed=false;
for(const [key,[file,name]] of Object.entries(contractMap)){
  const c=output.contracts?.[file]?.[name];if(!c)throw Error(`Missing compiled ${file}:${name}`);
  const bytecode=`0x${c.evm.bytecode.object}`;
  const creationBytes=c.evm.bytecode.object.length/2;
  const runtimeBytes=c.evm.deployedBytecode.object.length/2;
  if(runtimeBytes>24_576||creationBytes>49_152){console.error(`${key} exceeded Base code-size limits`);failed=true;}
  console.log(`${key}: creation ${creationBytes}, runtime ${runtimeBytes}`);
  artifacts[key]={abi:c.abi,bytecode,creationBytes,runtimeBytes,codeHash:keccak256(bytecode)};
}
if(failed)process.exit(1);
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
fs.writeFileSync(path.join(root,'artifacts/indexio-v342-adaptive-standard-json-input.json'),JSON.stringify(input));
fs.writeFileSync(path.join(root,'artifacts/indexio-v342-adaptive-artifacts.json'),JSON.stringify({status:'unreviewed-development-candidate',compiler:solc.version(),contracts:artifacts},null,2));
let ts='// GENERATED AFTER npm run compile:indexio-v342-adaptive; development candidate only.\n';
for(const [key,a] of Object.entries(artifacts)){
  const title=key==='zeroX'?'ZeroX':key[0].toUpperCase()+key.slice(1);
  ts+=`export const v342Adaptive${title}Abi=${JSON.stringify(a.abi)} as const;\n`;
  ts+=`export const v342Adaptive${title}Bytecode=${JSON.stringify(a.bytecode)} as \`0x\${string}\`;\n`;
  ts+=`export const v342Adaptive${title}CodeHash=${JSON.stringify(a.codeHash)} as \`0x\${string}\`;\n`;
}
fs.writeFileSync(path.join(root,'lib/indexio-v342-adaptive.generated.ts'),ts);
console.log('V3.4.2 adaptive artifacts generated. Legacy V3.3.8 artifacts were NOT touched.');
