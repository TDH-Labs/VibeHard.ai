import { describe, expect, test } from "bun:test";
import {
  assemblePrd,
  coercePrdDraft,
  coerceRequirements,
  deriveNfrs,
  prdChecklist,
  prdReviewVerdict,
  renderPrdMarkdown,
  reviewPrd,
  type PrdDraft,
} from "./prd.ts";
import type { Spec } from "../spec/index.ts";

function spec(over: Partial<Spec> = {}): Spec {
  return {
    name: "notes",
    summary: "per-user notes",
    features: ["sign in", "create note"],
    users: "people",
    tenancy: "multi-tenant",
    deployTarget: "hosted-app",
    auth: "email-password",
    storesData: true,
    dataEntities: [{ name: "notes", fields: ["id", "user_id"], sensitive: true }],
    sensitiveData: ["pii"],
    realUsers: true,
    maintained: true,
    ...over,
  };
}

/** A COMPLETE, internally-consistent draft covering every spec feature — the happy baseline
 *  each gap test perturbs by overriding one field. */
function fullDraft(s: Spec, over: Partial<PrdDraft> = {}): PrdDraft {
  return {
    title: `PRD for ${s.name}`,
    overview: `${s.name} lets each user keep their own data.`,
    problemStatement: "Users have nowhere private to keep this; shared tools leak across accounts.",
    objectives: ["Let a user manage only their own records", "Ship a usable v1"],
    constraints: ["Must run on the standard substrate"],
    personas: [{ name: "End user", kind: "primary", description: "wants their data private and quick to reach" }],
    scenarios: [{ id: "S1", persona: "End user", context: "signed in", action: "creates a record", outcome: "only they can see it" }],
    requirements: s.features.map((f, i) => ({
      id: `F${i + 1}`,
      feature: f,
      detail: `${f} — core to the product`,
      acceptance: ["a user can only see their own rows"],
      priority: "MVP" as const,
      scenarioRefs: ["S1"],
    })),
    outOfScope: [{ feature: "team sharing", reason: "deferred to V2" }],
    successMetrics: [{ kind: "primary", metric: "% of users who create a record in week 1" }],
    risks: [{ risk: "users mis-scope data", impact: "M", mitigation: "RLS enforced + verified" }],
    openQuestions: [],
    ...over,
  };
}

describe("deriveNfrs + assemblePrd", () => {
  test("a sensitive spec derives security NFRs; assemblePrd wires NFRs + buy-vs-build + status (not from the LLM)", () => {
    const s = spec();
    expect(deriveNfrs(s).length).toBeGreaterThan(0);
    const prd = assemblePrd(s, fullDraft(s));
    expect(prd.nfrs).toEqual(deriveNfrs(s));
    expect(prd.status).toBe("in-review");
    expect(prd.requirements).toHaveLength(s.features.length);
  });

  test("a trivial non-sensitive app derives no security NFRs", () => {
    const converter = spec({ tenancy: "single-user", auth: "none", storesData: false, dataEntities: [], sensitiveData: ["none"], features: ["convert"] });
    expect(deriveNfrs(converter)).toEqual([]);
  });
});

describe("reviewPrd — completeness + consistency (the disposer)", () => {
  test("a complete, consistent PRD → no blocking gaps (verdict passes)", () => {
    const s = spec();
    const v = prdReviewVerdict(assemblePrd(s, fullDraft(s)), "2026-06-21T00:00:00.000Z");
    expect(v.status).toBe("pass");
  });

  test("a spec feature with no requirement → coverage gap (blocks)", () => {
    const s = spec();
    const draft = fullDraft(s, { requirements: [{ id: "F1", feature: "sign in", detail: "d", acceptance: ["ok"], priority: "MVP", scenarioRefs: ["S1"] }] });
    const prd = assemblePrd(s, draft);
    expect(reviewPrd(prd).map((f) => f.ruleId)).toContain("requirement-coverage-gap");
    expect(prdReviewVerdict(prd).status).toBe("block");
  });

  test("a requirement with no acceptance criteria → blocks", () => {
    const s = spec();
    const draft = fullDraft(s);
    draft.requirements[0]!.acceptance = [];
    expect(reviewPrd(assemblePrd(s, draft)).map((f) => f.ruleId)).toContain("no-acceptance-criteria");
  });

  test("sensitive app whose NFRs somehow came out empty → no-nfrs (defense)", () => {
    const s = spec();
    const prd = { ...assemblePrd(s, fullDraft(s)), nfrs: [] };
    expect(reviewPrd(prd).map((f) => f.ruleId)).toContain("no-nfrs");
  });

  test("the strategic spine is required: missing problem/objectives/persona/scenarios/metrics each block", () => {
    const s = spec();
    const ids = (over: Partial<PrdDraft>) => reviewPrd(assemblePrd(s, fullDraft(s, over))).map((f) => f.ruleId);
    expect(ids({ problemStatement: "" })).toContain("no-problem-statement");
    expect(ids({ objectives: [] })).toContain("no-objectives");
    expect(ids({ personas: [{ name: "x", kind: "secondary", description: "d" }] })).toContain("no-primary-persona");
    expect(ids({ scenarios: [] })).toContain("no-scenarios");
    expect(ids({ successMetrics: [] })).toContain("no-success-metrics");
  });

  test("logical consistency: a feature referencing a missing scenario, or a scenario with an unknown persona, blocks", () => {
    const s = spec();
    const badRef = fullDraft(s);
    badRef.requirements[0]!.scenarioRefs = ["S9"]; // no such scenario
    expect(reviewPrd(assemblePrd(s, badRef)).map((f) => f.ruleId)).toContain("broken-scenario-ref");

    const badPersona = fullDraft(s, { scenarios: [{ id: "S1", persona: "Ghost", context: "c", action: "a", outcome: "o" }] });
    expect(reviewPrd(assemblePrd(s, badPersona)).map((f) => f.ruleId)).toContain("scenario-unknown-persona");
  });

  test("advisory nudges (medium, non-blocking): untraced feature + nothing out-of-scope", () => {
    const s = spec();
    const draft = fullDraft(s, { outOfScope: [] });
    draft.requirements[1]!.scenarioRefs = [];
    const gaps = reviewPrd(assemblePrd(s, draft));
    const ids = gaps.map((f) => f.ruleId);
    expect(ids).toContain("feature-untraced");
    expect(ids).toContain("no-out-of-scope");
    // advisory only — still passes the gate
    expect(prdReviewVerdict(assemblePrd(s, draft)).status).toBe("pass");
  });
});

describe("coerceRequirements / coercePrdDraft — trust boundary", () => {
  test("requirements: well-formed preserved, malformed dropped, ids + priority assigned, refs coerced", () => {
    const out = coerceRequirements([
      { feature: "a", detail: "d", acceptance: ["x", 5, ""], priority: "P1", scenarioRefs: ["S1", 7] },
      { detail: "only detail" },
      "junk",
      null,
      { nope: 1 },
    ]);
    expect(out).toEqual([
      { id: "F1", feature: "a", detail: "d", acceptance: ["x"], priority: "P1", scenarioRefs: ["S1"] },
      { id: "F2", feature: "", detail: "only detail", acceptance: [], priority: "MVP", scenarioRefs: [] },
    ]);
  });

  test("a malformed top-level response coerces to a near-empty draft (so the loop retries, not crashes)", () => {
    const s = spec();
    const draft = coercePrdDraft("not json at all", s);
    expect(draft.title).toBe(`PRD for ${s.name}`);
    expect(draft.requirements).toEqual([]);
    expect(draft.objectives).toEqual([]);
    // and that empty draft is correctly judged not-ready
    expect(reviewPrd(assemblePrd(s, draft)).some((f) => f.severity === "high")).toBe(true);
  });

  test("coercePrdDraft keeps valid nested content + drops junk", () => {
    const s = spec();
    const draft = coercePrdDraft(
      {
        overview: "ov",
        problemStatement: "ps",
        objectives: ["o1", 2, ""],
        personas: [{ name: "P", kind: "primary", description: "d" }, { description: "no name" }],
        scenarios: [{ id: "S1", persona: "P", context: "c", action: "a", outcome: "o" }],
        successMetrics: [{ kind: "primary", metric: "m", target: "t" }, { kind: "bogus", metric: "" }],
      },
      s,
    );
    expect(draft.objectives).toEqual(["o1"]);
    expect(draft.personas).toHaveLength(1);
    expect(draft.successMetrics).toEqual([{ kind: "primary", metric: "m", target: "t" }]);
  });
});

describe("renderPrdMarkdown + prdChecklist", () => {
  test("renders the template sections + an all-checked checklist for a complete PRD", () => {
    const s = spec();
    const prd = assemblePrd(s, fullDraft(s));
    const md = renderPrdMarkdown(prd);
    expect(md).toContain(`# PRD for ${s.name}`);
    expect(md).toContain("## Problem Statement");
    expect(md).toContain("## Features In-Scope");
    expect(md).toContain("## Success Metrics");
    expect(md).toContain("pending human review");
    expect(prdChecklist(prd).every((c) => c.ok)).toBe(true);
  });
});
