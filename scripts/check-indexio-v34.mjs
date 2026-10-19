import fs from 'node:fs';
import crypto from 'node:crypto';
const protectedFiles={
  "IndexioExecutionRouterV3.sol": "54c87dab8a262bf15ecc8f761d5a92e4c94610ed37502eb67364f3502607b7f9",
  "IndexioFactoryV338.sol": "779bc276b7a21722e3a1ab411d0c4dc3bb45d2e7d52b7d3d169a99bcad829e62",
  "IndexioVaultDeployerV338.sol": "936faf002cb9fb250f5708aef637840630d5ae6e6a6b54404f6b2ec72ab6ad06",
  "IndexioRestrictedSwapAdapterV3.sol": "cc456b85ecad0f61312af09063791f100c80069f1e2cde26d619afd80d8a88e5",
  "IndexioLifiSwapAdapterV3.sol": "3818fec4bf2a1d1ca6f1c146139ec15a481621ba4fd48174e4c85c672bd29aea",
  "IndexioShareTokenV3.sol": "b94da1bdd46c848bc6ac56456c8300bc0bf0ae53e005df70efb52b9573f26257",
  "IndexioIncomeHubV3.sol": "87e8a144157ab893725d90accdb70ee34eaff761c3a1836fe269b1ea7985f697"
};
for (const [file, expected] of Object.entries(protectedFiles)) {
  const actual=crypto.createHash('sha256').update(fs.readFileSync(`contracts/indexio-v3/${file}`)).digest('hex');
  if(actual!==expected)throw Error(`${file} changed since the baseline! Stop and review all trading and factory assumptions.`);
}
const vault=fs.readFileSync('contracts/indexio-v3/IndexioVaultV34.sol','utf8');
const governor=fs.readFileSync('contracts/indexio-v3/IndexioGovernorV34.sol','utf8');
if(!vault.includes('IndexioGovernorV34 gov=new IndexioGovernorV34'))throw Error('V3.4 vault does not deploy the new governor');
for (const text of ['function authorizeExecutionPlan', 'onlyPlanApprover', 'planValidUntil[id]>=block.timestamp', 'governanceNonce()==p.expectedNonce', 'function revokeExecutionPlan', 'function fastTrackUnanimous', '_unanimousCurrentOwners', '_executionReady', 'unanimouslyFastTracked[id]', 'token.balanceOf(voters[i])', 'INDEXIO_V3_4_1_UNANIMOUS_FAST_TRACK']){
  if(!governor.includes(text))throw Error(`Governor missing safety condition: ${text}`);
}
console.log('V3.4 source isolation and defensive checks: PASS. This is NOT an audit, compilation, or simulation.');
