import fs from 'node:fs';
import assert from 'node:assert/strict';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const suite=read('public/indexio-v342-suite-artifacts.json');
const adaptive=read('public/indexio-v342-adaptive-artifacts.json');
const size=read('public/indexio-v342-size-report.json');
assert.equal(suite.chainId,8453);
assert.equal(suite.version,'3.4.2');
assert.equal(adaptive.version,'3.4.2');
assert.equal(suite.compilerVersion,adaptive.compiler,'Compiler mismatch: all deployable artifacts must use one compiler');
assert.equal(suite.vaultCreationCodeHash,size.vaultCreationCodeHash);
assert.equal(suite.vaultCreationCodeLength,size.vaultCreationCodeLength);
assert(suite.vaultCreationCodeLength<=46000,'Need constructor-argument headroom');
assert(suite.vaultCreationCodeLength<=47000,'Two bytecode segments exhausted');
for(const item of size.compiledContracts){
 assert(item.runtimeBytes<=24576,`EIP-170 exceeded: ${item.file}:${item.name}`);
 assert(item.creationBytes<=49152,`EIP-3860 exceeded: ${item.file}:${item.name}`);
}
for(const [kind,a] of Object.entries(adaptive.contracts)){
 assert(a.runtimeBytes<=24576,`Adaptive runtime too large: ${kind}`);
 assert(a.creationBytes<=49152,`Adaptive init too large: ${kind}`);
}
for(const file of ['lib/indexio-v34.generated.ts','lib/indexio-v34-verification.generated.ts','lib/indexio-v342-adaptive.generated.ts','lib/indexio-v342-adaptive-verification.generated.ts']) assert(fs.existsSync(file),`Missing ${file}`);
console.log('PASS: V3.4.2 artifacts are generated, consistent and under bytecode size gates. On-chain gas/swap success NOT guaranteed.');
