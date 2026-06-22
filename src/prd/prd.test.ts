import { describe, expect, test } from "bun:test";
import { assemblePrd, coerceRequirements, deriveNfrs, prdReviewVerdict, reviewPrd, type Requirement } from "./prd.ts";
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

const req = (feature: string, acceptance: string[] = ["it works, verifiably"]): Requirement => ({ feature, detail: `${feature} detail`, acceptance });
/** A PRD whose requirements cover every spec feature. */
const fullReqs = (s: Spec) => s.features.map((f) => req(f));

describe("deriveNfrs + assemblePrd", () => {
  test("a sensitive spec derives security NFRs; assemblePrd wires NFRs + buy-vs-build (not from the LLM)", () => {
    const s = spec();
    expect(deriveNfrs(s).length).toBeGreaterThan(0);
    const prd = assemblePrd(s, fullReqs(s));
    expect(prd.nfrs).toEqual(deriveNfrs(s));
    expect(prd.requirements).toHaveLength(s.features.length);
  });

  test("a trivial non-sensitive app derives no security NFRs", () => {
    const converter = spec({ tenancy: "single-user", auth: "none", storesData: false, dataEntities: [], sensitiveData: ["none"], features: ["convert"] });
    expect(deriveNfrs(converter)).toEqual([]);
  });
});

describe("reviewPrd — completeness (the disposer)", () => {
  test("a complete PRD → no blocking gaps (verdict passes)", () => {
    const s = spec();
    const v = prdReviewVerdict(assemblePrd(s, fullReqs(s)), "2026-06-21T00:00:00.000Z");
    expect(v.status).toBe("pass");
  });

  test("a spec feature with no requirement → coverage gap (blocks)", () => {
    const s = spec();
    const prd = assemblePrd(s, [req("sign in")]); // missing "create note"
    const ids = reviewPrd(prd).map((f) => f.ruleId);
    expect(ids).toContain("requirement-coverage-gap");
    expect(prdReviewVerdict(prd).status).toBe("block");
  });

  test("a requirement with no acceptance criteria → blocks", () => {
    const s = spec();
    const prd = assemblePrd(s, [req("sign in", []), req("create note")]);
    expect(reviewPrd(prd).map((f) => f.ruleId)).toContain("no-acceptance-criteria");
  });

  test("sensitive app whose NFRs somehow came out empty → no-nfrs (defense)", () => {
    const s = spec();
    const prd = { ...assemblePrd(s, fullReqs(s)), nfrs: [] };
    expect(reviewPrd(prd).map((f) => f.ruleId)).toContain("no-nfrs");
  });
});

describe("coerceRequirements — trust boundary", () => {
  test("well-formed array preserved; malformed entries dropped; types coerced", () => {
    const out = coerceRequirements([
      { feature: "a", detail: "d", acceptance: ["x", 5, ""] },
      { detail: "only detail" },
      "junk",
      null,
      { nope: 1 },
    ]);
    expect(out).toEqual([
      { feature: "a", detail: "d", acceptance: ["x"] },
      { feature: "", detail: "only detail", acceptance: [] },
    ]);
  });

  test("non-array → empty", () => {
    expect(coerceRequirements({ requirements: [] })).toEqual([]);
    expect(coerceRequirements(null)).toEqual([]);
  });
});
