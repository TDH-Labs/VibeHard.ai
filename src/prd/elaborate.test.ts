import { describe, expect, test } from "bun:test";
import { elaboratePrd, type Elaborator } from "./elaborate.ts";
import type { Requirement } from "./prd.ts";
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
const full = (s: Spec): Requirement[] => s.features.map((f) => ({ feature: f, detail: `${f} detail`, acceptance: ["verifiable"] }));

describe("elaboratePrd — grill loop (LLM proposes requirements, reviewPrd disposes)", () => {
  test("a complete first elaboration → one round, ready; NFRs derived (not from the elaborator)", async () => {
    const s = spec();
    const elaborator: Elaborator = async () => full(s);
    const r = await elaboratePrd(s, { elaborator });
    expect(r.ready).toBe(true);
    expect(r.rounds).toBe(1);
    expect(r.prd.nfrs.length).toBeGreaterThan(0); // derived deterministically
    expect(r.prd.buyVsBuild).toBeDefined();
  });

  test("incomplete, then fixed → two rounds, ready", async () => {
    const s = spec();
    const drafts = [[{ feature: "sign in", detail: "d", acceptance: ["ok"] }], full(s)]; // round 1 misses "create note"
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
    const elaborator: Elaborator = async () => [{ feature: "sign in", detail: "d", acceptance: [] }]; // always missing + no acceptance
    const r = await elaboratePrd(s, { elaborator, budget: 2 });
    expect(r.rounds).toBe(2);
    expect(r.ready).toBe(false);
    expect(r.gaps.some((g) => g.ruleId === "requirement-coverage-gap" || g.ruleId === "no-acceptance-criteria")).toBe(true);
  });
});
