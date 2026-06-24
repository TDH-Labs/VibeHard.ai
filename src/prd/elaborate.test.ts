import { describe, expect, test } from "bun:test";
import { elaboratePrd, type Elaborator } from "./elaborate.ts";
import type { PrdDraft } from "./prd.ts";
import type { Spec } from "../spec/index.ts";

function spec(over: Partial<Spec> = {}): Spec {
  return {
    name: "notes",
    summary: "per-user notes",
    features: ["sign in", "create note"],
    users: "people",
    tenancy: "multi-tenant",
    auth: "email-password",
    storesData: true,
    dataEntities: [{ name: "notes", fields: ["id", "user_id"], sensitive: true }],
    sensitiveData: ["pii"],
    realUsers: true,
    maintained: true,
    ...over,
  };
}

/** A complete, consistent draft covering every spec feature — what a good elaboration returns. */
function fullDraft(s: Spec, over: Partial<PrdDraft> = {}): PrdDraft {
  return {
    title: `PRD for ${s.name}`,
    overview: "lets each user keep their own data",
    problemStatement: "no private place for this today",
    objectives: ["private per-user data", "usable v1"],
    constraints: [],
    personas: [{ name: "User", kind: "primary", description: "wants privacy" }],
    scenarios: [{ id: "S1", persona: "User", context: "signed in", action: "creates a record", outcome: "only they see it" }],
    requirements: s.features.map((f, i) => ({ id: `F${i + 1}`, feature: f, detail: `${f} detail`, acceptance: ["verifiable"], priority: "MVP" as const, scenarioRefs: ["S1"] })),
    outOfScope: [{ feature: "sharing", reason: "V2" }],
    successMetrics: [{ kind: "primary", metric: "weekly active creators" }],
    risks: [],
    openQuestions: [],
    ...over,
  };
}

describe("elaboratePrd — grill loop (LLM proposes the draft, reviewPrd disposes)", () => {
  test("a complete first elaboration → one round, ready; NFRs derived (not from the elaborator)", async () => {
    const s = spec();
    const elaborator: Elaborator = async () => fullDraft(s);
    const r = await elaboratePrd(s, { elaborator });
    expect(r.ready).toBe(true);
    expect(r.rounds).toBe(1);
    expect(r.prd.nfrs.length).toBeGreaterThan(0); // derived deterministically
    expect(r.prd.buyVsBuild).toBeDefined();
  });

  test("incomplete, then fixed → two rounds, ready", async () => {
    const s = spec();
    // round 1 misses "create note"; round 2 is complete
    const drafts = [fullDraft(s, { requirements: [{ id: "F1", feature: "sign in", detail: "d", acceptance: ["ok"], priority: "MVP", scenarioRefs: ["S1"] }] }), fullDraft(s)];
    let i = 0;
    const elaborator: Elaborator = async (_s, prior) => {
      expect(i === 0 ? prior === null : prior !== null).toBe(true);
      return drafts[Math.min(i++, drafts.length - 1)]!;
    };
    const r = await elaboratePrd(s, { elaborator });
    expect(r.rounds).toBe(2);
    expect(r.ready).toBe(true);
  });

  test("never-complete → stops at budget, NOT ready (a bad elaboration can't force ready)", async () => {
    const s = spec();
    // always missing "create note" AND no acceptance criteria
    const elaborator: Elaborator = async () => fullDraft(s, { requirements: [{ id: "F1", feature: "sign in", detail: "d", acceptance: [], priority: "MVP", scenarioRefs: ["S1"] }] });
    const r = await elaboratePrd(s, { elaborator, budget: 2 });
    expect(r.rounds).toBe(2);
    expect(r.ready).toBe(false);
    expect(r.gaps.some((g) => g.ruleId === "requirement-coverage-gap" || g.ruleId === "no-acceptance-criteria")).toBe(true);
  });
});
