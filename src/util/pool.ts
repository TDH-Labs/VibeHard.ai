/**
 * Bounded-concurrency map (backlog #4, parallel codegen). Runs `fn` over `items` with at most
 * `limit` in flight at once, preserving result order (results[i] corresponds to items[i]). The
 * workhorse for parallelizing independent same-tier workstreams without unleashing an unbounded
 * fan-out of LLM calls. Pure control flow — no I/O of its own — so it's unit-tested directly.
 *
 * A thrown `fn` propagates (Promise.all rejects): callers that must not fail loudly should make
 * `fn` return a result type instead of throwing.
 */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const n = items.length;
  const results: R[] = new Array(n);
  if (n === 0) return results;
  const cap = Math.max(1, Math.min(limit, n));
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}

/**
 * Run dependency tiers: tiers strictly SEQUENTIAL, items WITHIN a tier concurrent (capped). Each
 * `generate(item, builtSoFar)` sees the items from all EARLIER tiers (never its own tier — those
 * are independent), so the snapshot is identical to running the whole thing sequentially. Returns
 * false (and stops) the moment a tier has any falsy result — a failure is never masked by a
 * sibling's success. The codegen orchestration, factored out so it's testable without an engine.
 */
export async function runTiers<W>(
  tiers: W[][],
  concurrency: number,
  generate: (item: W, builtSoFar: W[]) => Promise<boolean>,
  onTier?: (tier: W[], index: number) => void,
): Promise<boolean> {
  const built: W[] = [];
  for (let t = 0; t < tiers.length; t++) {
    const tier = tiers[t]!;
    onTier?.(tier, t);
    const oks = await mapPool(tier, concurrency, (ws) => generate(ws, built));
    if (oks.some((ok) => !ok)) return false;
    built.push(...tier);
  }
  return true;
}
