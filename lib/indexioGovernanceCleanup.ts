/** Known invalid proposal, identified by verified Base creation receipt + immutable governor storage.
 * UI-only archival: this never cancels or modifies a contract proposal.
 */
const FUTURE_10 = '0x84665d393ac6377c9cdc478f87b89d2f2febeef1';
const ORIGINAL_MIX_HASH = '0x2b32950ad3bef5080095e112fee4e1a9fc10f7e1610f58e4d59b100cfc2642d3';
export function isKnownInvalidLegacyProposal(vault: string | undefined, id: bigint, mixHash?: string, executionHash?: string): boolean {
  return vault?.toLowerCase()===FUTURE_10 && id===1n &&
    mixHash?.toLowerCase()===ORIGINAL_MIX_HASH && executionHash?.toLowerCase()===ORIGINAL_MIX_HASH;
}
export function isActionableProposal(state: number, invalidLegacy = false): boolean {
  return !invalidLegacy && [1,3,4,5].includes(state);
}
export function isNonemptyPlan(plan: {trades: unknown[]}): boolean {
  return Array.isArray(plan.trades) && plan.trades.length > 0;
}
