import { describe, expect, test } from "bun:test";
import { checkOpenRouterBudget, type CreditsFetcher } from "./provider-budget.ts";

const fetcherOf = (total_credits: number, total_usage: number): CreditsFetcher => async () => ({ total_credits, total_usage });
const throwingFetcher: CreditsFetcher = async () => {
  throw new Error("network hiccup");
};

describe("checkOpenRouterBudget", () => {
  test("no OPENROUTER_API_KEY in env → nothing to check, passes", async () => {
    const r = await checkOpenRouterBudget({}, { fetcher: fetcherOf(0, 0) });
    expect(r.ok).toBe(true);
  });

  test("healthy balance → ok, reports remaining", async () => {
    const r = await checkOpenRouterBudget({ OPENROUTER_API_KEY: "sk-or-x" }, { fetcher: fetcherOf(115, 20) });
    expect(r.ok).toBe(true);
    expect(r.remainingUsd).toBe(95);
  });

  test("the actual incident this closes: $115 credits, $115.18 usage → blocked, not a wasted build", async () => {
    const r = await checkOpenRouterBudget({ OPENROUTER_API_KEY: "sk-or-x" }, { fetcher: fetcherOf(115, 115.18) });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("add credits");
  });

  test("balance below the floor but not negative → still blocked", async () => {
    const r = await checkOpenRouterBudget({ OPENROUTER_API_KEY: "sk-or-x" }, { fetcher: fetcherOf(100, 99.5), minUsd: 1 });
    expect(r.ok).toBe(false);
  });

  test("custom minUsd floor is honored", async () => {
    const r = await checkOpenRouterBudget({ OPENROUTER_API_KEY: "sk-or-x" }, { fetcher: fetcherOf(100, 90), minUsd: 5 });
    expect(r.ok).toBe(true); // $10 left clears a $5 floor
    const blocked = await checkOpenRouterBudget({ OPENROUTER_API_KEY: "sk-or-x" }, { fetcher: fetcherOf(100, 96), minUsd: 5 });
    expect(blocked.ok).toBe(false); // $4 left doesn't
  });

  test("VIBEHARD_MIN_CREDITS_USD env override is honored when no explicit minUsd given", async () => {
    const r = await checkOpenRouterBudget({ OPENROUTER_API_KEY: "sk-or-x", VIBEHARD_MIN_CREDITS_USD: "50" }, { fetcher: fetcherOf(100, 60) });
    expect(r.ok).toBe(false); // $40 left, under the $50 override floor
  });

  test("the check's OWN failure (network, malformed response) fails OPEN — an unrelated glitch never blocks a build", async () => {
    const r = await checkOpenRouterBudget({ OPENROUTER_API_KEY: "sk-or-x" }, { fetcher: throwingFetcher });
    expect(r.ok).toBe(true);
  });
});
