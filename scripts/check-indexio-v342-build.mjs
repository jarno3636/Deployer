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

// Check generated module *exports* as well as presence: missing symbols otherwise only fail much later in Turbopack.
const expectedExports={
 'lib/indexio-v34.generated.ts':[
  'indexioV34SafetyControllerAbi','indexioV34SafetyControllerBytecode',
  'indexioV34TransferPolicyAbi','indexioV34TransferPolicyBytecode',
  'indexioV34CodeBlobAbi','indexioV34CodeBlobBytecode',
  'indexioV34VaultDeployerAbi','indexioV34VaultDeployerBytecode',
  'indexioV34FactoryAbi','indexioV34FactoryBytecode',
  'indexioV34ExecutionRouterAbi','indexioV34ExecutionRouterBytecode',
  'indexioV34RestrictedSwapAdapterAbi','indexioV34RestrictedSwapAdapterBytecode',
  'indexioV34LifiSwapAdapterAbi','indexioV34LifiSwapAdapterBytecode',
  'indexioV34VaultBytecode','indexioV34VaultCreationCodeHash',
  'indexioV34VaultCreationCodeLength','indexioV34CompilerVersion','indexioV34BytecodeSizes'
 ],
 'lib/indexio-v34-verification.generated.ts':['indexioV34StandardJsonInput'],
 'lib/indexio-v342-adaptive.generated.ts':[
  'v342AdaptiveRouterAbi','v342AdaptiveRouterBytecode',
  'v342AdaptiveZeroXAbi','v342AdaptiveZeroXBytecode',
  'v342AdaptiveLifiAbi','v342AdaptiveLifiBytecode'
 ],
 'lib/indexio-v342-adaptive-verification.generated.ts':['indexioV342AdaptiveStandardJsonInput']
};
for(const [file, names] of Object.entries(expectedExports)){
 const source=fs.readFileSync(file,'utf8');
 for(const name of names){
  assert(source.includes(`export const ${name}=`),`${file} missing required frontend export ${name}`);
 }
}
for(const file of ['public/indexio-v34-vault-artifact.json','public/indexio-v342-suite-artifacts.json',
                    'public/indexio-v342-adaptive-artifacts.json','public/indexio-v342-size-report.json']){
 assert(fs.existsSync(file),`Downloadable V3.4.2 artifact is missing: ${file}`);
}
// Ensure production UI static imports can resolve before Next/Turbopack starts.
for(const [component, generated] of [
 ['components/IndexioV34Deployer.tsx',['indexio-v34.generated','indexio-v342-adaptive.generated']],
 ['app/api/etherscan/verify-indexio-v34/route.ts',['indexio-v34-verification.generated','indexio-v342-adaptive-verification.generated']]
]){
 const source=fs.readFileSync(component,'utf8');
 for(const suffix of generated) assert(source.includes(suffix),`${component} does not reference ${suffix}`);
}

console.log('PASS: V3.4.2 artifacts are generated, consistent and under bytecode size gates. On-chain gas/swap success NOT guaranteed.');
