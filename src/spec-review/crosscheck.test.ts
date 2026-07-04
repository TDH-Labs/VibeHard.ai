import { describe, expect, test } from "bun:test";
import { crossCheck } from "./crosscheck.ts";
import type { Spec } from "../spec/index.ts";
import type { Prd, Requirement } from "../prd/index.ts";
import type { Architecture, Workstream } from "../architecture/index.ts";

function spec(over: Partial<Spec> = {}): Spec {
  return {
    name: "app",
    summary: "",
    features: ["sign in", "create note"],
    users: "",
    tenancy: "multi-tenant",
    auth: "email-password",
    storesData: true,
    dataEntities: [{ name: "notes", fields: ["id"], sensitive: true }],
    sensitiveData: ["pii"],
    realUsers: true,
    maintained: true,
    ...over,
  };
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
function arch(over: Partial<Architecture> = {}): Architecture {
  return {
    prd: prd(),
    stack: "Next.js + Supabase",
    workstreams: [ws("db", ["supabase/migrations/001.sql"], "schema + RLS"), ws("api", ["api.ts"], "REST"), ws("ui", ["ui.tsx"], "frontend")],
    systemOverview: "app",
    architecturalGoals: [],
    pattern: { name: "m", rationale: "r", tradeoffs: "t" },
    dataFlow: "REST",
    dataArchitecture: { storageRationale: "", schema: "", stateManagement: "" },
    ...over,
  };
}

describe("crossCheck — spec ↔ PRD ↔ architecture consistency", () => {
  test("a coherent bundle → no findings", () => {
    expect(crossCheck(spec(), prd(), arch())).toEqual([]);
  });

  test("PRD dropped a spec feature → prd-misses-spec-feature (blocking)", () => {
    const p = prd({ requirements: [req("sign in")] }); // "create note" lost
    const fnd = crossCheck(spec(), p, arch()).find((x) => x.ruleId === "prd-misses-spec-feature");
    expect(fnd?.severity).toBe("high");
    expect(fnd?.message).toContain("create note");
  });

  test("data app with no schema workstream → architecture-misses-data-layer (high if sensitive, else medium)", () => {
    const noData = arch({ workstreams: [ws("api", ["api.ts"], "REST"), ws("ui", ["ui.tsx"], "frontend")] });
    expect(crossCheck(spec(), prd(), noData).find((x) => x.ruleId === "architecture-misses-data-layer")?.severity).toBe("high");

    const nonSensitive = spec({ sensitiveData: ["none"], dataEntities: [{ name: "x", fields: ["a"], sensitive: false }] });
    expect(crossCheck(nonSensitive, prd({ spec: nonSensitive }), noData).find((x) => x.ruleId === "architecture-misses-data-layer")?.severity).toBe("medium");
  });

  test("a workstream that builds a BUY category, with NO evidence the service was adopted → builds-what-should-be-bought (advisory)", () => {
    const p = prd({ buyVsBuild: [{ category: "payments", recommendation: "buy", service: "Stripe", services: ["Stripe"], rationale: "use Stripe" }] });
    const a = arch({ stack: "Next.js + Supabase", workstreams: [ws("db", ["supabase/migrations/1.sql"], "schema"), ws("payments", ["pay.ts"], "build payment processing")] });
    expect(crossCheck(spec(), p, a).map((x) => x.ruleId)).toContain("builds-what-should-be-bought");
  });

  test("the regression this closes: the architecture's stack already names an accepted option → no false-positive finding", () => {
    // Found 2026-07-04: this fired on every real build regardless of outcome, including ones that
    // correctly wired Supabase Auth (an accepted buy option, not hand-rolled) or Resend (the
    // headline recommendation itself) — because it only ever checked the workstream's NAME, never
    // what the architecture said it was actually using.
    const p = prd({
      buyVsBuild: [
        { category: "authentication", recommendation: "buy", service: "Clerk", services: ["Clerk", "Auth0", "Supabase Auth"], rationale: "r" },
        { category: "email & notifications", recommendation: "buy", service: "Resend", services: ["Resend", "SendGrid", "Twilio"], rationale: "r" },
      ],
    });
    const a = arch({
      stack: "Next.js + Supabase (Postgres + Auth + RLS) + TypeScript + Tailwind + Resend",
      workstreams: [ws("db", ["supabase/migrations/1.sql"], "schema"), ws("auth", ["auth.ts"], "sign-in via Supabase Auth"), ws("email", ["mail.ts"], "send notifications via Resend")],
    });
    expect(crossCheck(spec(), p, a).map((x) => x.ruleId)).not.toContain("builds-what-should-be-bought");
  });
});
