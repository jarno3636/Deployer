/** Pure helpers for the existing V3.3.8 sell-for-USDC quote lifecycle. */
export type SellQuotePreview = {
  sharesRaw: string;
  quoted: string;
  minimum: string;
  quotedRaw: string;
  minimumRaw: string;
  lossPct: number;
  warning: string;
  fetchedAt: number;
};

function formatUsdMicro(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function sellQuotePreviewFromResponse(
  response: {shares?: unknown; projectedSettlementOut?: unknown; minSettlementOut?: unknown; transferPolicyWarnings?: unknown},
  sharesRaw: string,
  now = Date.now(),
): SellQuotePreview {
  if (String(response.shares) !== sharesRaw) throw Error('The sale quote does not match your selected shares.');
  const quoted = BigInt(String(response.projectedSettlementOut));
  const minimum = BigInt(String(response.minSettlementOut));
  if (quoted <= 0n || minimum <= 0n || minimum > quoted) throw Error('The sell quote has invalid USDC amounts. Refresh the quote.');
  const lossPct = Number((quoted - minimum) * 10_000n / quoted) / 100;
  const taxedAssets = Array.isArray(response.transferPolicyWarnings) ? response.transferPolicyWarnings.length : 0;
  return {
    sharesRaw,
    quoted: formatUsdMicro(quoted),
    minimum: formatUsdMicro(minimum),
    quotedRaw: String(quoted),
    minimumRaw: String(minimum),
    lossPct,
    warning: (lossPct > 10
      ? 'High execution uncertainty. Review liquidity before selling.'
      : lossPct > 3
        ? 'Execution may vary significantly from this quote.'
        : 'Minimum USDC is protected by the contract. Prices may change until your wallet confirms.')
      + (taxedAssets > 0 ? ` ${taxedAssets} holding${taxedAssets === 1 ? '' : 's'} allow transfer loss. This is a policy setting, not proof that the swap adapter supports the actual token tax.` : ''),
    fetchedAt: now,
  };
}

/** A refreshed minimum more than 1% worse than the reviewed minimum needs fresh consent. */
export function sellQuoteHasMaterialDrop(reviewedMinimum: bigint, nextMinimum: bigint): boolean {
  if (reviewedMinimum <= 0n || nextMinimum <= 0n) return true;
  return nextMinimum * 10_000n < reviewedMinimum * 9_900n;
}

/** Only re-quote automatically when no wallet request has been sent yet. */
export function isExpiredSellRoute(error: unknown): boolean {
  let details = '';
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== 'object') {
      if (typeof current === 'string') details += ` ${current}`;
      break;
    }
    const item = current as {message?: string; shortMessage?: string; details?: string; reason?: string; cause?: unknown};
    details += ` ${item.message || ''} ${item.shortMessage || ''} ${item.details || ''} ${item.reason || ''}`;
    current = item.cause;
  }
  return /(?:quote|route|order|swap).*expir(?:ed|y)|expir(?:ed|y).*(?:quote|route|order|swap)|stale quote/i.test(details);
}
