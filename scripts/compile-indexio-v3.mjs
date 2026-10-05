import fs from 'node:fs';import path from 'node:path';import solc from 'solc';import {keccak256} from 'viem';
const root=process.cwd();
const entries=['IndexioSafetyControllerV3.sol','IndexioVaultV3.sol','IndexioVaultDeployerV3.sol','IndexioFactoryV3.sol','IndexioExecutionRouterV3.sol','IndexioRestrictedSwapAdapterV3.sol'].map(x=>`contracts/indexio-v3/${x}`);const pat=/import\s+(?:[^"']*?from\s+)?["']([^"']+)["']\s*;/g;const sources={};
function resolve(from,r){if(r.startsWith('@'))return r;if(r.startsWith('.'))return path.posix.normalize(path.posix.join(path.posix.dirname(from),r));return r;}function disk(k){return k.startsWith('@openzeppelin/')?path.join(root,'node_modules',k):path.join(root,k);}function add(k){if(sources[k])return;const d=disk(k);if(!fs.existsSync(d))throw new Error(`Cannot resolve ${k}`);const c=fs.readFileSync(d,'utf8');sources[k]={content:c};for(const m of c.matchAll(pat))add(resolve(k,m[1]));}for(const e of entries)add(e);
const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:500},viaIR:true,outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','metadata']}}}};const output=JSON.parse(solc.compile(JSON.stringify(input)));for(const e of output.errors||[])(e.severity==='error'?console.error:console.warn)(e.formattedMessage||e.message);if((output.errors||[]).some(e=>e.severity==='error'))process.exit(1);
const targets=[['safetyController','contracts/indexio-v3/IndexioSafetyControllerV3.sol','IndexioSafetyControllerV3'],['vault','contracts/indexio-v3/IndexioVaultV3.sol','IndexioVaultV3'],['vaultDeployer','contracts/indexio-v3/IndexioVaultDeployerV3.sol','IndexioVaultDeployerV3'],['factory','contracts/indexio-v3/IndexioFactoryV3.sol','IndexioFactoryV3'],['executionRouter','contracts/indexio-v3/IndexioExecutionRouterV3.sol','IndexioExecutionRouterV3'],['restrictedSwapAdapter','contracts/indexio-v3/IndexioRestrictedSwapAdapterV3.sol','IndexioRestrictedSwapAdapterV3']];
function art(src,n){const c=output.contracts?.[src]?.[n];if(!c)throw new Error(`Missing ${src}:${n}`);return{abi:c.abi,bytecode:`0x${c.evm.bytecode.object}`,creationBytes:c.evm.bytecode.object.length/2,runtimeBytes:c.evm.deployedBytecode.object.length/2};}const A=Object.fromEntries(targets.map(([k,s,n])=>[k,art(s,n)]));const vaultHash=keccak256(A.vault.bytecode);const vaultLength=A.vault.creationBytes;
let g=`// AUTO-GENERATED V3\nexport const indexioV3CompilerVersion=${JSON.stringify(solc.version())} as const;\nexport const indexioV3VaultCreationCodeHash=${JSON.stringify(vaultHash)} as \`0x\${string}\`;\nexport const indexioV3VaultCreationCodeLength=${vaultLength} as const;\n`;for(const[k]of targets){const a=A[k],pre=`indexioV3${k[0].toUpperCase()}${k.slice(1)}`;g+=`export const ${pre}Abi=${JSON.stringify(a.abi)} as const;\nexport const ${pre}Bytecode=${JSON.stringify(a.bytecode)} as \`0x\${string}\`;\n`;}fs.writeFileSync(path.join(root,'lib/indexio-v3.generated.ts'),g);
// Export the exact audited Vault creation artifact as a static, public build asset.
// This contains no secrets; it is deterministic contract creation bytecode used by Indexio.world.
fs.mkdirSync(path.join(root,'public'),{recursive:true});
fs.writeFileSync(path.join(root,'public/indexio-v3-vault-artifact.json'),JSON.stringify({
  version:'3.1.0',
  network:'Base Mainnet',
  chainId:8453,
  compilerVersion:solc.version(),
  creationCodeHash:vaultHash,
  creationCodeLength:vaultLength,
  bytecode:A.vault.bytecode
}));fs.writeFileSync(path.join(root,'artifacts/indexio-v3-standard-json-input.json'),JSON.stringify(input));fs.writeFileSync(path.join(root,'lib/indexio-v3-verification.generated.ts'),`export const indexioV3StandardJsonInput=${JSON.stringify(JSON.stringify(input))} as const;\n`);
let failed=false;for(const[k]of targets){console.log(`${k}: ${A[k].creationBytes} creation; ${A[k].runtimeBytes} runtime`);if(A[k].runtimeBytes>24_576){console.error(`${k} exceeds EIP-170 runtime limit`);failed=true;}}if(A.vault.creationBytes>49_152){console.error(`vault init code exceeds EIP-3860 limit: ${A.vault.creationBytes}`);failed=true;}console.log(`vaultCreationCodeHash: ${vaultHash}`);if(failed)process.exit(1);
