/** Keep third-party swap calldata and raw RPC exceptions out of investor-facing errors. */
function errorDetails(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 12000);
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  const fields = ['shortMessage', 'reason', 'details', 'message', 'errorName', 'code'];
  let out = fields.map(key => typeof obj[key] === 'string' || typeof obj[key] === 'number' ? String(obj[key]) : '').join(' ');
  for (const key of ['cause', 'error']) {
    const child = obj[key];
    if (child && typeof child === 'object' && child !== value) {
      const nested = child as Record<string, unknown>;
      out += ' ' + fields.map(k => typeof nested[k] === 'string' || typeof nested[k] === 'number' ? String(nested[k]) : '').join(' ');
    }
  }
  return out.slice(0, 12000);
}

export function isTransferPolicyError(value: unknown): boolean {
  return /transfer exceeds policy/i.test(errorDetails(value));
}

export function indexioFriendlyTradeError(error: unknown, operation: 'seed'|'buy'|'sell'|'create'|'claim'|'general'='general'): string {
  const raw = errorDetails(error);
  if (isTransferPolicyError(error)) return 'A token transfer delivered less than the index’s current tax allowance permits. Check the token’s transfer policy and your wallet activity before trying again.';
  if (/revert(?:ed|s)?(?: with)?(?: the following)? reason:?\s*weight\b|execution reverted:?\s*weight\b|\breverted:?\s*weight\b/i.test(raw)) return 'The quoted investment mix no longer matches the index’s required allocations. Refresh the quote and try again. Check wallet activity before retrying.';
  if (/user rejected|user denied|rejected the request|code: ?4001|rpc 4001|\b4001\b/i.test(raw)) return 'The wallet confirmation was canceled or could not be completed. Nothing was submitted by this attempt.';
  if (/insufficient funds|exceeds balance|not enough funds/i.test(raw)) return 'The wallet may not have enough USDC or ETH for this transaction and network fee. Check both balances.';
  if (/insufficient allowance|erc20insufficientallowance|allowance/i.test(raw)) return 'The spending approval was not available on Base yet. Wait for the approval to confirm, then try again.';
  // viem includes the Solidity argument name `deadline` in its full Contract Call
  // trace, even if the actual revert was unrelated. Only recognize an explicit
  // expiry reason, never the presence of an ABI parameter named deadline.
  if (/(?:revert(?:ed)?(?: with)?(?: the following)? reason:?\s*|execution reverted:?\s*)(?:['\"]?)(?:deadline|expired|stale quote)\b|(?:quote|route|order|swap)\s+(?:has\s+)?expired\b|\bdeadline (?:has )?(?:passed|expired|exceeded)\b/i.test(raw)) {
    return operation === 'sell'
      ? 'A sell route explicitly failed its expiry check. Refresh the sale quote and retry once; no transaction was submitted by this simulation.'
      : 'The quote expired before confirmation. Get a fresh quote to continue.';
  }
  if (/slippage|insufficient output|too little received|minamountout|minimum.*output|price impact/i.test(raw)) return 'Market prices or liquidity changed beyond your protected minimum. Refresh the quote and try again.';
  if (/no executable.*route|no protected.*route|route.*not available|adapter.*not approved|unauthorized target|selector.*not approved|swap target.*not allowed/i.test(raw)) return 'A protected swap route is not available for an asset in this index. Try again later or ask the Indexio team to review that asset.';
  if (/paused/i.test(raw)) return 'Trading is temporarily paused for this index. No transaction was sent.';
  if (/execution reverted|contract function|\breverted\b/i.test(raw)) {
    // Show only a concise contract reason, never the full simulation calldata.
    const matches = raw.match(/(?:reverted with the following reason|execution reverted|revert reason):?\s*['\"]?([a-z][a-z0-9 _./-]{1,75})/i);
    const reason = matches?.[1]?.trim().replace(/(?:\s*contract call.*)$/i, '').slice(0, 75);
    return operation === 'sell'
      ? `The USDC sale failed its on-chain simulation${reason ? `: ${reason}` : ''}. Check this vault’s sell-route diagnostic for token tax and adapter compatibility. No sale was submitted.`
      : `${operation === 'seed' ? 'The first investment' : operation === 'create' ? 'Index creation' : 'The transaction'} could not pass Base’s safety checks. Check wallet activity before trying again.`;
  }
  // Unknown RPC exceptions should not leak embedded routeData and full contract calls into the UI.
  if (raw.length > 210 || /Contract Call:|routeData|0x[\da-f]{64,}/i.test(raw)) return 'The transaction could not be prepared. Please refresh and try again. No automatic retry was made.';
  return raw.trim() || 'Something interrupted the transaction. Check wallet activity before trying again.';
}
