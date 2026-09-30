import fs from 'node:fs';
const read=(f)=>fs.readFileSync(f,'utf8');
const checks=[
 ['Factory blocks launches before finalization','contracts/indexio-v25/IndexioFactoryV25.sol',/launchIndex[\s\S]{0,500}!bootstrapFinalized/],
 ['Rebalance authorizations expire','contracts/indexio-v25/IndexioRebalanceRouterV25.sol',/validUntil/],
 ['Reinvestment operator additions delayed','contracts/indexio-v25/IndexioReinvestmentRouterV25.sol',/OPERATOR_DELAY=6 hours[\s\S]*proposeOperator[\s\S]*activateOperator/],
 ['Adapter binds target+spender+selector','contracts/indexio-v25/IndexioRestrictedSwapAdapterV25.sol',/routeKey\(address target,address spender,bytes4 selector\)/],
 ['Adapter route additions delayed','contracts/indexio-v25/IndexioRestrictedSwapAdapterV25.sol',/ALLOWLIST_DELAY=6 hours[\s\S]*proposeRoute[\s\S]*activateRoute/],
 ['Execution slippage cap','contracts/indexio-v25/IndexioExecutionRouterV25.sol',/MAX_SLIPPAGE_BPS = 500[\s\S]*_validateSlippage/],
 ['Rebalance slippage cap','contracts/indexio-v25/IndexioRebalanceRouterV25.sol',/MAX_SLIPPAGE_BPS=500/],
 ['Reinvestment slippage cap','contracts/indexio-v25/IndexioReinvestmentRouterV25.sol',/MAX_SLIPPAGE_BPS=500/],
 ['Vault rescue is Factory-only','contracts/indexio-v25/IndexioVaultV25.sol',/function recoverAccidentalToken[\s\S]*?external onlyFactory nonReentrant/],
 ['Vault rescue protects settlement token','contracts/indexio-v25/IndexioVaultV25.sol',/token==settlementToken/],
 ['Vault rescue protects constituents','contracts/indexio-v25/IndexioVaultV25.sol',/_isConstituent\(token\)/],
 ['Factory rescue destination is treasury','contracts/indexio-v25/IndexioFactoryV25.sol',/recoverVaultAccidentalToken[\s\S]*?recipient=feeTreasury/],
 ['Execution rescue protects settlement token','contracts/indexio-v25/IndexioExecutionRouterV25.sol',/recoverAccidentalToken[\s\S]*?token==settlementToken/],
 ['Reinvestment rescue protects settlement token','contracts/indexio-v25/IndexioReinvestmentRouterV25.sol',/recoverAccidentalToken[\s\S]*?token==settlementToken/],
];
let bad=0; for(const [name,file,re] of checks){const ok=re.test(read(file));console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)bad++;}
if(bad)process.exit(1);

