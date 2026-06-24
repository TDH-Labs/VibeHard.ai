import { describe, expect, test } from "bun:test";
import { elaborateSrs, type Specifier } from "./elaborate.ts";
import type { SrsDraft } from "./srs.ts";
import type { Spec } from "../spec/index.ts";
import type { Prd } from "../prd/index.ts";

function spec(): Spec {
  return { name: "portal", summary: "", features: ["sign in"], users: "", tenancy: "multi-tenant", auth: "email-password", storesData: true, dataEntities: [{ name: "a", fields: ["id"], sensitive: true }], sensitiveData: ["pii"], realUsers: true, maintained: true };
}
function prd(): Prd {
  const s = spec();
  return {
    spec: s, status: "in-review", title: "PRD", overview: "o", problemStatement: "p", objectives: ["x"],
    constraints: [], personas: [], scenarios: [], requirements: [{ id: "F1", feature: "sign in", detail: "d", acceptance: ["a"], priority: "MVP", scenarioRefs: [] }],
    outOfScope: [], successMetrics: [], risks: [], openQuestions: [], nfrs: ["s"], buyVsBuild: [],
  };
}
function fullDraft(over: Partial<SrsDraft> = {}): SrsDraft {
  return {
    purpose: "p", audience: "e", systemScope: "s", definitions: [], systemPerspective: "sp", modules: ["m"], designConstraints: [],
    functionalRequirements: [{ id: "FR-1", title: "t", description: "d", actor: "u", covers: ["F1"], inputs: [{ element: "x", type: "UUID", constraints: "nn", source: "body" }], outputs: [], workflow: ["s1"], errors: [{ condition: "c", action: "a", response: "400" }] }],
    uiRequirements: [], apiInterfaces: [], performance: { throughput: ">=10 req/s", latencyP99: "<300ms", resourceLimit: "512MB" }, reliability: { uptime: "99.9%", rpo: "24h", rto: "1h" },
    openIssues: [], dataModel: [{ name: "a", fields: ["id"], notes: "" }], ...over,
  };
}

describe("elaborateSrs — grill loop (LLM proposes the draft, reviewSrs disposes)", () => {
  test("a complete first specification → one round, ready; env/security derived (not from the LLM)", async () => {
    const p = prd();
    const specifier: Specifier = async () => fullDraft();
    const r = await elaborateSrs(p, { specifier });
    expect(r.ready).toBe(true);
    expect(r.rounds).toBe(1);
    expect(r.srs.security.encryptionAtRest).toContain("AES-256"); // derived deterministically
  });

  test("incomplete (no functional requirements), then fixed → two rounds", async () => {
    const p = prd();
    const drafts = [fullDraft({ functionalRequirements: [] }), fullDraft()];
    let i = 0;
    const specifier: Specifier = async (_p, prior) => {
      expect(i === 0 ? prior === null : prior !== null).toBe(true);
      return drafts[Math.min(i++, drafts.length - 1)]!;
    };
    const r = await elaborateSrs(p, { specifier });
    expect(r.rounds).toBe(2);
    expect(r.ready).toBe(true);
  });

  test("never-complete → stops at budget, NOT ready", async () => {
    const p = prd();
    const specifier: Specifier = async () => fullDraft({ functionalRequirements: [] });
    const r = await elaborateSrs(p, { specifier, budget: 2 });
    expect(r.rounds).toBe(2);
    expect(r.ready).toBe(false);
    expect(r.gaps.some((g) => g.ruleId === "fr-coverage-gap")).toBe(true);
  });
});
