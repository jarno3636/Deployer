/**
 * Source invariant and model checks for the V3.3.4 audit candidate.
 * These are NOT substitutes for Solidity compilation, mainnet-fork tests,
 * or independent security review.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = name => fs.readFileSync(`contracts/indexio-v3/${name}.sol`, 'utf8');
const vault = read('IndexioVaultV3');
const router = read('IndexioExecutionRouterV3');
const lifi = read('IndexioLifiSwapAdapterV3');
const zero = read('IndexioRestrictedSwapAdapterV3');
const policy = read('IndexioTransferPolicyV3');
const governor = read('IndexioGovernorV3');
const factory = read('IndexioFactoryV3');
const hub = read('IndexioIncomeHubV3');
const deployer = fs.readFileSync('components/IndexioV32Deployer.tsx', 'utf8');

const checks = [
  ['immutable reused registry configured', deployer.includes('0x5C4791e3B752d9b084E8FD76932E82C2031f15c1') && factory.includes('address public immutable registry')],
  ['fixed 1% protocol fee', vault.includes('INDEXIO_FEE_BPS=100') && factory.includes('INDEXIO_FEE_BPS=100')],
  ['fee treasury nonzero', factory.includes('treasury_!=address(0)')],
  ['creator-controlled preseed editing stopped after seed', vault.includes('msg.sender==creator') && vault.includes('!seeded&&!closed&&shareToken.totalSupply()==0')],
  ['governance share-weighted + protected execution', governor.includes('getPastVotes') && governor.includes('dataHash') && governor.includes('executionHash') && governor.includes('COMPOSITION_EXIT=3 days')],
  ['router requires approved adapter to swap', router.includes('approvedAdapter[sellLegs[i].adapter]') && router.includes('approvedAdapter[t.adapter]')],
  ['tax policy bounded to 20% losses', policy.includes('MIN_RECEIVE_BPS = 8_000') && vault.includes('_enforceTransferFloor') && router.includes('transfer exceeds policy')],
  ['vault rejects asymmetric deposits', vault.includes('MAX_DEPOSIT_IMBALANCE_BPS=100') && vault.includes('imbalanced deposit')],
  ['dust redemption can skip a zero-value leg', vault.includes('if(amount==0)return 0;') && router.includes('if(routerAmount==0)')],
  ['buy refunds against settlement pre-pull baseline', router.includes('uint256 settlementBaseline=IERC20(settlementToken).balanceOf(address(this));') && router.includes('settlementRefund=settlementBalance-settlementBaseline')],
  ['router preserves exact settlement accounting', router.includes('settlement nonstandard') && router.includes('settlement deficit')],
  ['0x adapter cannot be permanently blocked by donated dust', zero.includes('inBefore >= amountIn') && zero.includes('inBefore - inAfter == amountIn')],
  ['LI.FI adapter protects earlier balances and output residue', lifi.includes('inBefore-inAfter!=amountIn') && lifi.includes('adapterOutBefore')],
  ['both adapters reset token approvals', zero.includes('forceApprove(ZERO_X_ALLOWANCE_HOLDER, 0)') && lifi.includes('forceApprove(spender,0)')],
  ['LI.FI upgrades timelocked and immediate disabling', lifi.includes('ALLOWLIST_DELAY = 6 hours') && lifi.includes('bootstrapFinalized&&allowed')],
  ['no adapter recovery/withdraw function', !/function\s+(recover|rescue|sweep|withdraw)/i.test(zero + lifi)],
  ['dividend / income payout + transfer checkpoint accounting still present', hub.includes('notifyIncome') && hub.includes('syncTransfer') && hub.includes('claim')],
  ['deployment checks actual PATIENCE policy', deployer.includes('patiencePolicy:Number(rate)>=8000&&Number(rate)<=9900')],
  ['deployment blocks stale adapter and router versions', deployer.includes('RELEASE_ABI') && deployer.includes('releaseIdentity:releaseReads.every')],
];

let failures = 0;
for (const [desc, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${desc}`);
  if (!ok) failures++;
}

// Small, independently runnable mathematical MODEL checks, not EVM tests.
const bps = 10_000n;
const floor = (amount, receiveBps) => amount * BigInt(receiveBps) / bps;
assert.equal(floor(1_000_000n, 9900), 990_000n, 'PATIENCE gross -> expected net');
assert.equal(floor(1_000_000n, 10_000), 1_000_000n, 'USDC exact');
const initialRouterUsdc = 25n;
const pulled = 100n;
const accepted = 90n;
const afterDeposit = initialRouterUsdc + pulled - accepted;
assert.equal(afterDeposit - initialRouterUsdc, 10n, 'refund leftover USDC even when basket contains USDC');
const nominal = 2n;
const firstAssetRawBalance = 1n;
const shares = 1n;
const totalSupply = 100n;
assert.equal(firstAssetRawBalance * shares / totalSupply, 0n, 'small proportional redemption leg may round to zero');
console.log('PASS: four independent accounting model checks');

if (failures) process.exitCode = 1;
