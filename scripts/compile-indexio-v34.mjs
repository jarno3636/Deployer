import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { keccak256 } from 'viem';

const root=process.cwd();
const entries=['IndexioSafetyControllerV3.sol','IndexioTransferPolicyV3.sol','IndexioVaultV34.sol','IndexioVaultCodeBlobV338.sol','IndexioVaultDeployerV338.sol','IndexioFactoryV338.sol','IndexioExecutionRouterV3.sol','IndexioRestrictedSwapAdapterV3.sol','IndexioLifiSwapAdapterV3.sol'].map(x=>`contracts/indexio-v3/${x}`);
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
 ['vault','contracts/indexio-v3/IndexioVaultV34.sol','IndexioVaultV34'],
 ['codeBlob','contracts/indexio-v3/IndexioVaultCodeBlobV338.sol','IndexioVaultCodeBlobV338'],
 ['vaultDeployer','contracts/indexio-v3/IndexioVaultDeployerV338.sol','IndexioVaultDeployerV338'],
 ['factory','contracts/indexio-v3/IndexioFactoryV338.sol','IndexioFactoryV338'],
 ['executionRouter','contracts/indexio-v3/IndexioExecutionRouterV3.sol','IndexioExecutionRouterV3'],
 ['restrictedSwapAdapter','contracts/indexio-v3/IndexioRestrictedSwapAdapterV3.sol','IndexioRestrictedSwapAdapterV3'],
 ['lifiSwapAdapter','contracts/indexio-v3/IndexioLifiSwapAdapterV3.sol','IndexioLifiSwapAdapterV3'],
];
function artifact(src,name){const c=output.contracts?.[src]?.[name];if(!c)throw new Error(`Missing ${src}:${name}`);return {abi:c.abi,bytecode:`0x${c.evm.bytecode.object}`,creationBytes:c.evm.bytecode.object.length/2,runtimeBytes:c.evm.deployedBytecode.object.length/2};}
const A=Object.fromEntries(targets.map(([k,s,n])=>[k,artifact(s,n)]));
// Include code spawned by the vault constructor (governor, income hub, shares) in the checks.
const ALL_CONCRETE=[];
let failed=false;
for(const [file, entries] of Object.entries(output.contracts||{})) for(const [name,c] of Object.entries(entries)) {
 const creation=c.evm?.bytecode?.object||'';
 const runtime=c.evm?.deployedBytecode?.object||'';
 if (!creation || !runtime || /[^0-9a-f]/i.test(creation+runtime)) continue;
 const creationBytes=creation.length/2,runtimeBytes=runtime.length/2;
 ALL_CONCRETE.push({file,name,creationBytes,runtimeBytes});
 if (runtimeBytes>24_576||creationBytes>49_152){console.error(`${file}:${name} exceeds EIP-170/EIP-3860 limits: ${creationBytes} init; ${runtimeBytes} runtime`);failed=true;}
}

const vaultHash=keccak256(A.vault.bytecode), vaultLength=A.vault.creationBytes;
let generated=`// AUTO-GENERATED Indexio V3.4.2 artifacts. Do not edit.\nexport const indexioV34CompilerVersion=${JSON.stringify(solc.version())} as const;\nexport const indexioV34VaultCreationCodeHash=${JSON.stringify(vaultHash)} as \`0x\${string}\`;\nexport const indexioV34VaultCreationCodeLength=${vaultLength} as const;\n`;
generated+=`export const indexioV34BytecodeSizes=${JSON.stringify(Object.fromEntries(targets.map(([k])=>[k,{creationBytes:A[k].creationBytes,runtimeBytes:A[k].runtimeBytes}]))) } as const;\n`;
for(const [k] of targets){const a=A[k],prefix=`indexioV34${k[0].toUpperCase()}${k.slice(1)}`;generated+=`export const ${prefix}Abi=${JSON.stringify(a.abi)} as const;\nexport const ${prefix}Bytecode=${JSON.stringify(a.bytecode)} as \`0x\${string}\`;\n`;}
// Persist generated artifacts only after the size gates pass (below).
fs.mkdirSync(path.join(root,'public'),{recursive:true});
// Artifact JSON is generated below after safety gates pass.
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
// Standard JSON is generated below after safety gates pass.
// Etherscan input is generated below after safety gates pass.
for(const [k] of targets){console.log(`${k}: ${A[k].creationBytes} creation; ${A[k].runtimeBytes} runtime`);if(A[k].runtimeBytes>24_576){console.error(`${k} exceeds EIP-170 runtime limit`);failed=true;}}
if(vaultLength>49_152){console.error(`Vault init code exceeds EIP-3860 limit: ${vaultLength}`);failed=true;}
if(vaultLength>47_000){console.error(`Vault init code exceeds the two-blob storage capacity: ${vaultLength}`);failed=true;}
if(vaultLength>46_000){console.error(`Vault init code (${vaultLength} bytes) has insufficient constructor-argument headroom (46,000 byte defensive ceiling)`);failed=true;}
const maxSegment=Math.ceil(vaultLength/2);
if(maxSegment>23_500){console.error(`Code blob segment (${maxSegment} bytes) exceeds the 23,500-byte constructor rule`);failed=true;}
if(A.codeBlob.runtimeBytes>24_576){console.error('Code blob exceeds EIP-170 runtime limit');failed=true;}
console.log(`vaultCreationCodeHash: ${vaultHash}`);if(failed)process.exit(1);
fs.writeFileSync(path.join(root,'lib/indexio-v34.generated.ts'),generated);
fs.writeFileSync(path.join(root,'public/indexio-v34-vault-artifact.json'),JSON.stringify({version:'3.4.2',network:'Base Mainnet',chainId:8453,compilerVersion:solc.version(),creationCodeHash:vaultHash,creationCodeLength:vaultLength,bytecode:A.vault.bytecode}));
fs.writeFileSync(path.join(root,'artifacts/indexio-v34-standard-json-input.json'),JSON.stringify(input));
fs.writeFileSync(path.join(root,'lib/indexio-v34-verification.generated.ts'),`// AUTO-GENERATED Indexio V3.4.2 Etherscan verification input. Do not edit.\nexport const indexioV34StandardJsonInput=${JSON.stringify(JSON.stringify(input))} as const;\n`);
fs.writeFileSync(path.join(root,'public/indexio-v342-suite-artifacts.json'),JSON.stringify({version:'3.4.2',chainId:8453,network:'Base Mainnet',compilerVersion:solc.version(),optimizer:{enabled:true,runs:500,viaIR:true},vaultCreationCodeHash:vaultHash,vaultCreationCodeLength:vaultLength,contracts:Object.fromEntries(Object.entries(A).map(([key,a])=>[key,{...a,bytecodeHash:keccak256(a.bytecode)}])),compiledContracts:ALL_CONCRETE,gasAndSimulation:'Required separately before each mainnet wallet submission'},null,2));
fs.writeFileSync(path.join(root,'public/indexio-v342-size-report.json'),JSON.stringify({compilerVersion:solc.version(),chainId:8453,hardLimits:{maxRuntimeBytes:24576,maxInitCodeBytes:49152,maxBlobPayloadBytes:23500,maxVaultCreationBytes:46000},vaultCreationCodeHash:vaultHash,vaultCreationCodeLength:vaultLength,compiledContracts:ALL_CONCRETE},null,2));

