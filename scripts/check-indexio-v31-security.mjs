import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');
const vault = read('contracts/indexio-v3/IndexioVaultV3.sol');
const router = read('contracts/indexio-v3/IndexioExecutionRouterV3.sol');
const factory = read('contracts/indexio-v3/IndexioFactoryV3.sol');
const policy = read('contracts/indexio-v3/IndexioTransferPolicyV3.sol');

const checks = [
  ['pre-seed creator edit exists', /function\s+updatePreSeedComposition\(/.test(vault)],
  ['pre-seed edit permanently stops after seed', /require\(!seeded&&!closed&&shareToken\.totalSupply\(\)==0,"already active"\)/.test(vault)],
  ['vault measures transfer balance deltas', /function\s+_pullReceived\(/.test(vault) && /function\s+_pushReceived\(/.test(vault)],
  ['old nonstandard-token exact pull removed', !/"nonstandard token"/.test(vault)],
  ['sell path measures adapter receipt', /uint256 adapterAmount=_pushMeasured\(assets\[i\],sellLegs\[i\]\.adapter,routerAmount\)/.test(router)],
  ['rebalance uses measured adapter input', /transferForRebalance\(t\.tokenIn,t\.adapter,t\.amountIn\)/.test(router)],
  ['settlement token remains exact', /settlement nonstandard/.test(router)],
  ['factory pins transfer policy', /address public immutable transferPolicy/.test(factory)],
  ['policy defaults standard assets to 10000 bps', /return p\.configured \? p\.receiveBps : BPS/.test(policy)],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
