/**
 * Pre-flight balance check for OpenRouter-backed builds (found live 2026-07-09: the platform's
 * OpenRouter account ran to ~$0, and the first sign of it was a build dying mid-plan on "requires
 * more credits" after several stages — including the front-half planning the user was waiting
 * on — had already run and burned what was left). Checking the balance BEFORE spawning a build
 * turns that into an immediate, clear refusal instead of another wasted partial build.
 *
 * Advisory in one direction only: if the balance check ITSELF fails (network hiccup, endpoint
 * down, malformed response), the build proceeds — an unrelated API glitch here must not block an
 * otherwise-healthy build. Only a CONFIRMED low balance blocks. This mirrors the fail-open
 * discipline in spec-review/review.ts (an advisory check's own failure ≠ the thing it's advising on).
 */

export interface BudgetStatus {
  ok: boolean;
  remainingUsd?: number;
  reason?: string;
}

export type CreditsFetcher = (apiKey: string) => Promise<{ total_credits: number; total_usage: number }>;

export const fetchOpenRouterCredits: CreditsFetcher = async (apiKey) => {
  const res = await fetch("https://openrouter.ai/api/v1/credits", { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`openrouter credits check: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { total_credits?: number; total_usage?: number } };
  const total_credits = body.data?.total_credits;
  const total_usage = body.data?.total_usage;
  if (typeof total_credits !== "number" || typeof total_usage !== "number") throw new Error("openrouter credits check: malformed response");
  return { total_credits, total_usage };
};

// A single planning stage costs cents (a few thousand tokens on deepseek-v4-pro is well under
// $0.05). This is a "don't even bother starting" floor, not a tight per-build budget — high
// enough to catch the $0-balance case, low enough to never false-positive on a healthy account.
const DEFAULT_MIN_USD = 1;

/** Only meaningful for openrouter (the one provider with a public balance endpoint) — a missing
 *  key or a non-openrouter provider (anthropic direct, opencode, or a tenant's own key of some
 *  other shape) has nothing to check here and passes through. */
export async function checkOpenRouterBudget(
  env: Record<string, string | undefined>,
  opts: { fetcher?: CreditsFetcher; minUsd?: number } = {},
): Promise<BudgetStatus> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: true };
  const fetcher = opts.fetcher ?? fetchOpenRouterCredits;
  const minUsd = opts.minUsd ?? (Number(env.VIBEHARD_MIN_CREDITS_USD) || DEFAULT_MIN_USD);
  try {
    const { total_credits, total_usage } = await fetcher(apiKey);
    const remainingUsd = total_credits - total_usage;
    if (remainingUsd < minUsd) {
      return {
        ok: false,
        remainingUsd,
        reason: `the LLM account backing this build has $${remainingUsd.toFixed(2)} left — add credits before starting a build`,
      };
    }
    return { ok: true, remainingUsd };
  } catch {
    return { ok: true };
  }
}
