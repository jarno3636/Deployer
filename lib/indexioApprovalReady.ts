/** A successful approval receipt is not itself proof the trade spender has
 * enough allowance on the RPC used for the following simulation. Read the
 * effective allowance again, allowing a brief cross-RPC synchronization lag.
 * This function never submits a transaction and fails closed. */
export async function waitForApprovedAllowance(
  readAllowance: () => Promise<bigint>,
  required: bigint,
  options: { attempts?: number; intervalMs?: number; delay?: (ms:number)=>Promise<void> } = {},
): Promise<bigint> {
  if (required <= 0n) throw Error('Enter an amount greater than zero.');
  const attempts = Math.max(1, Math.min(10, options.attempts ?? 6));
  const intervalMs = Math.max(0, Math.min(5_000, options.intervalMs ?? 1_400));
  const delay = options.delay ?? ((ms:number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let lastError: unknown = null;
  for (let attempt=0; attempt<attempts; attempt++) {
    if (attempt > 0) await delay(intervalMs);
    try {
      const allowance = await readAllowance();
      if (allowance >= required) return allowance;
      lastError = null;
    } catch (error) { lastError = error; }
  }
  throw Error(lastError
    ? 'Your approval was confirmed, but your wallet permission could not be checked yet. No trade was sent. Refresh and try again.'
    : 'Your approval was confirmed, but the amount allowed is still too low. No trade was sent. Check your wallet before trying again.');
}
