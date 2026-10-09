import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { keccak256 } from 'viem';

const root=process.cwd();
const entries=['IndexioSafetyControllerV3.sol','IndexioTransferPolicyV3.sol','IndexioVaultV3.sol','IndexioVaultCodeBlobV338.sol','IndexioVaultDeployerV338.sol','IndexioFactoryV338.sol','IndexioExecutionRouterV3.sol','IndexioRestrictedSwapAdapterV3.sol','IndexioLifiSwapAdapterV3.sol'].map(x=>`contracts/indexio-v3/${x}`);
const pat=/import\s+(?:[^"']*?from\s+)?["']([^"']+)["']\s*;/g, sources={};
function resolve(from,r){if(r.startsWith('@'))return r;if(r.startsWith('.'))return path.posix.normalize(path.posix.join(path.posix.dirname(from),r));return r;}
function disk(k){return k.startsWith('@openzeppelin/')?path.join(root,'node_modules',k):path.join(root,k);}
function add(k){if(sources[k])return;const d=disk(k);if(!fs.existsSync(d))throw new Error(`Cannot resolve ${k}`);const content=fs.readFileSync(d,'utf8');sources[k]={content};for(const m of content.matchAll(pat))add(resolve(k,m[1]));}
for(const e of entries)add(e);
const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:500},viaIR:true,outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','metadata']}}}};
const output=JSON.parse(solc.compile(JSON.stringify(input)));
for(const e of output.errors||[])(e.severity==='error'?console.error:console.warn)(e.formattedMessage||e.message);
if((output.errors||[]).some(e=>e.severity==='error'))process.exit(1);
const targets=[
 ['safetyController','contracts/indexio-v3/IndexioSafetyControllerV3.sol','IndexioSafetyControllerV3'],
 ['transferPolicy','contracts/indexio-v3/IndexioTransferPolicyV3.sol','IndexioTransferPolicyV3'],
 ['vault','contracts/indexio-v3/IndexioVaultV3.sol','IndexioVaultV3'],
 ['codeBlob','contracts/indexio-v3/IndexioVaultCodeBlobV338.sol','IndexioVaultCodeBlobV338'],
 ['vaultDeployer','contracts/indexio-v3/IndexioVaultDeployerV338.sol','IndexioVaultDeployerV338'],
 ['factory','contracts/indexio-v3/IndexioFactoryV338.sol','IndexioFactoryV338'],
 ['executionRouter','contracts/indexio-v3/IndexioExecutionRouterV3.sol','IndexioExecutionRouterV3'],
 ['restrictedSwapAdapter','contracts/indexio-v3/IndexioRestrictedSwapAdapterV3.sol','IndexioRestrictedSwapAdapterV3'],
 ['lifiSwapAdapter','contracts/indexio-v3/IndexioLifiSwapAdapterV3.sol','IndexioLifiSwapAdapterV3'],
];
function artifact(src,name){const c=output.contracts?.[src]?.[name];if(!c)throw new Error(`Missing ${src}:${name}`);return {abi:c.abi,bytecode:`0x${c.evm.bytecode.object}`,creationBytes:c.evm.bytecode.object.length/2,runtimeBytes:c.evm.deployedBytecode.object.length/2};}
const A=Object.fromEntries(targets.map(([k,s,n])=>[k,artifact(s,n)]));
const vaultHash=keccak256(A.vault.bytecode), vaultLength=A.vault.creationBytes;
let generated=`// AUTO-GENERATED Indexio V3.3.8 artifacts. Do not edit.\nexport const indexioV338CompilerVersion=${JSON.stringify(solc.version())} as const;\nexport const indexioV338VaultCreationCodeHash=${JSON.stringify(vaultHash)} as \`0x\${string}\`;\nexport const indexioV338VaultCreationCodeLength=${vaultLength} as const;\n`;
for(const [k] of targets){const a=A[k],prefix=`indexioV338${k[0].toUpperCase()}${k.slice(1)}`;generated+=`export const ${prefix}Abi=${JSON.stringify(a.abi)} as const;\nexport const ${prefix}Bytecode=${JSON.stringify(a.bytecode)} as \`0x\${string}\`;\n`;}
fs.writeFileSync(path.join(root,'lib/indexio-v338.generated.ts'),generated);
fs.mkdirSync(path.join(root,'public'),{recursive:true});
fs.writeFileSync(path.join(root,'public/indexio-v338-vault-artifact.json'),JSON.stringify({version:'3.3.8',network:'Base Mainnet',chainId:8453,compilerVersion:solc.version(),creationCodeHash:vaultHash,creationCodeLength:vaultLength,bytecode:A.vault.bytecode}));
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
fs.writeFileSync(path.join(root,'artifacts/indexio-v338-standard-json-input.json'),JSON.stringify(input));
let failed=false;
for(const [k] of targets){console.log(`${k}: ${A[k].creationBytes} creation; ${A[k].runtimeBytes} runtime`);if(A[k].runtimeBytes>24_576){console.error(`${k} exceeds EIP-170 runtime limit`);failed=true;}}
if(vaultLength>49_152){console.error(`Vault init code exceeds EIP-3860 limit: ${vaultLength}`);failed=true;}
if(vaultLength>47_000){console.error(`Vault init code exceeds the two-blob storage capacity: ${vaultLength}`);failed=true;}
if(A.codeBlob.runtimeBytes>24_576){console.error('Code blob exceeds EIP-170 runtime limit');failed=true;}
console.log(`vaultCreationCodeHash: ${vaultHash}`);if(failed)process.exit(1);
