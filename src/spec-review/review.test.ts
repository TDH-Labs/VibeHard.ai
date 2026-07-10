import { describe, expect, test } from "bun:test";
import { reviewFrontHalf, type Adversary, type FrontHalfBundle } from "./review.ts";
import { coerceAdversarialFindings } from "./adversary-llm.ts";
import type { Spec } from "../spec/index.ts";
import type { Prd, Requirement } from "../prd/index.ts";
import type { Architecture, Workstream } from "../architecture/index.ts";

function spec(over: Partial<Spec> = {}): Spec {
  return { name: "app", summary: "", features: ["sign in", "create note"], users: "", tenancy: "multi-tenant", deployTarget: "hosted-app", auth: "email-password", storesData: true, dataEntities: [{ name: "notes", fields: ["id"], sensitive: true }], sensitiveData: ["pii"], realUsers: true, maintained: true, ...over };
}
const req = (feature: string): Requirement => ({ id: feature, feature, detail: "d", acceptance: ["x"], priority: "MVP", scenarioRefs: [] });
function prd(over: Partial<Prd> = {}): Prd {
  return {
    spec: spec(), status: "in-review", title: "PRD", overview: "", problemStatement: "", objectives: [],
    constraints: [], personas: [], scenarios: [], requirements: [req("sign in"), req("create note")],
    outOfScope: [], successMetrics: [], risks: [], openQuestions: [], nfrs: ["secure"], buyVsBuild: [], ...over,
  };
}
const ws = (name: string, files: string[], responsibility = name): Workstream => ({ name, responsibility, files, dependsOn: [], covers: [] });
const arch: Architecture = {
  prd: prd(),
  stack: "Next.js",
  workstreams: [ws("db", ["supabase/migrations/001.sql"], "schema + RLS"), ws("ui", ["ui.tsx"], "frontend")],
  systemOverview: "app",
  architecturalGoals: [],
  pattern: { name: "m", rationale: "r", tradeoffs: "t" },
  dataFlow: "REST",
  dataArchitecture: { storageRationale: "", schema: "", stateManagement: "" },
};
const bundle: FrontHalfBundle = { spec: spec(), prd: prd(), architecture: arch };

describe("reviewFrontHalf — deterministic disposes, the adversary surfaces", () => {
  test("no adversary + coherent plan → not blocked, nothing flagged", async () => {
    const r = await reviewFrontHalf(bundle);
    expect(r.crossChecks).toEqual([]);
    expect(r.adversarial).toEqual([]);
    expect(r.blocked).toBe(false);
  });

  test("a blocking cross-check → blocked", async () => {
    const r = await reviewFrontHalf({ ...bundle, prd: prd({ requirements: [] }) }); // drops both features
    expect(r.blocked).toBe(true);
  });

  test("§11: the adversary SURFACES but NEVER blocks; high findings → needsHuman", async () => {
    const adversary: Adversary = async () => [
      { tool: "spec-review", ruleId: "spec-risk", severity: "high", file: "front-half", message: "[security] stores PHI but spec says non-sensitive" },
      { tool: "spec-review", ruleId: "spec-risk", severity: "low", file: "front-half", message: "[scope] minor scope creep" },
    ];
    const r = await reviewFrontHalf(bundle, { adversary }); // coherent → no cross-checks
    expect(r.blocked).toBe(false); // an LLM 'high' does NOT block — only objective checks do
    expect(r.adversarial).toHaveLength(2);
    expect(r.needsHuman).toHaveLength(1); // only the high one routes to a human
  });

  test("adversary throws (provider hiccup) → fails OPEN, not blocked, front-half work survives (2026-07-09 crash)", async () => {
    const adversary: Adversary = async () => {
      throw new Error("whitespace-only model response");
    };
    const r = await reviewFrontHalf(bundle, { adversary });
    expect(r.blocked).toBe(false); // cross-checks alone decide `blocked` — a dead adversary can't block either
    expect(r.needsHuman).toHaveLength(0); // the failure note is low severity — never routes to a human
    expect(r.adversarial).toHaveLength(1);
    expect(r.adversarial[0]!.ruleId).toBe("adversary-unavailable");
    expect(r.adversarial[0]!.message).toContain("whitespace-only model response");
  });
});

describe("coerceAdversarialFindings — trust boundary on the red-team's JSON", () => {
  test("valid coerced (lens folded into the message); malformed/empty dropped", () => {
    const out = coerceAdversarialFindings({
      findings: [
        { lens: "security", severity: "high", issue: "PHI unflagged", where: "spec" },
        { nope: 1 },
        { severity: "high" }, // no issue → dropped
        "junk",
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tool: "spec-review", ruleId: "spec-risk", severity: "high", file: "spec" });
    expect(out[0]!.message).toBe("[security] PHI unflagged");
  });

  test("bad severity → medium; missing lens → 'review'; non-object → empty", () => {
    expect(coerceAdversarialFindings({ findings: [{ issue: "x", severity: "galaxy" }] })[0]).toMatchObject({ severity: "medium", message: "[review] x" });
    expect(coerceAdversarialFindings(null)).toEqual([]);
  });
});
