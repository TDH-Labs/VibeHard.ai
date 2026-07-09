import { describe, expect, test } from "bun:test";
import {
  assembleSrs,
  coerceSrsDraft,
  deriveCompliance,
  deriveOperatingEnvironment,
  deriveSecurityPosture,
  renderSrsMarkdown,
  reviewSrs,
  srsReviewVerdict,
  type FunctionalRequirement,
  type SrsDraft,
} from "./srs.ts";
import type { Spec } from "../spec/index.ts";
import type { Prd } from "../prd/index.ts";

function spec(over: Partial<Spec> = {}): Spec {
  return {
    name: "portal",
    summary: "",
    features: ["sign in", "book"],
    users: "",
    tenancy: "multi-tenant",
    deployTarget: "hosted-app",
    auth: "email-password",
    storesData: true,
    dataEntities: [{ name: "appointments", fields: ["id", "user_id"], sensitive: true }],
    sensitiveData: ["pii"],
    realUsers: true,
    maintained: true,
    ...over,
  };
}
function prd(over: Partial<Prd> = {}): Prd {
  const s = over.spec ?? spec();
  return {
    spec: s,
    status: "in-review",
    title: "PRD",
    overview: "o",
    problemStatement: "p",
    objectives: ["obj"],
    constraints: [],
    personas: [],
    scenarios: [],
    requirements: [
      { id: "F1", feature: "sign in", detail: "d", acceptance: ["a"], priority: "MVP", scenarioRefs: [] },
      { id: "F2", feature: "book", detail: "d", acceptance: ["a"], priority: "MVP", scenarioRefs: [] },
    ],
    outOfScope: [],
    successMetrics: [],
    risks: [],
    openQuestions: [],
    nfrs: ["secure"],
    buyVsBuild: [],
    ...over,
  };
}

const fr = (id: string, covers: string[], over: Partial<FunctionalRequirement> = {}): FunctionalRequirement => ({
  id,
  title: `${id} title`,
  description: "d",
  actor: "user",
  covers,
  inputs: [{ element: "x", type: "UUIDv4", constraints: "not null", source: "body" }],
  outputs: [{ element: "y", type: "JSON", constraints: "schema", source: "db" }],
  workflow: ["step 1"],
  errors: [{ condition: "bad input", action: "abort", response: "400" }],
  ...over,
});

function fullDraft(p: Prd, over: Partial<SrsDraft> = {}): SrsDraft {
  return {
    purpose: "Specify the portal backend.",
    audience: "Engineers, QA",
    systemScope: "Booking + notes; excludes billing.",
    definitions: [{ term: "RLS", definition: "Row-Level Security" }],
    systemPerspective: "Standalone app on the platform substrate.",
    modules: ["Auth", "Booking"],
    designConstraints: ["TypeScript"],
    functionalRequirements: p.requirements.map((r, i) => fr(`FR-${i + 1}`, [r.id])),
    uiRequirements: ["WCAG 2.1 AA", "responsive to 320px"],
    apiInterfaces: [{ target: "Supabase REST", protocol: "REST/HTTPS", purpose: "data", dataFormat: "JSON" }],
    performance: { throughput: ">= 50 req/s", latencyP99: "< 300ms", resourceLimit: "<= 512MB RAM" },
    reliability: { uptime: "99.9%/month", rpo: "24h", rto: "1h" },
    openIssues: [],
    dataModel: [{ name: "appointments", fields: ["id", "user_id", "time"], notes: "" }],
    ...over,
  };
}

describe("derivations — substrate facts, not LLM guesses", () => {
  test("operating environment, security, and compliance derive from the spec", () => {
    const s = spec();
    expect(deriveOperatingEnvironment(s).database).toContain("PostgreSQL");
    const sec = deriveSecurityPosture(s);
    expect(sec.encryptionAtRest).toContain("AES-256");
    expect(sec.encryptionInTransit).toContain("TLS 1.3");
    expect(sec.dataIsolation).toContain("Row-Level Security");
    expect(deriveCompliance(s).some((c) => c.includes("GDPR"))).toBe(true);
  });
  test("a stateless / non-sensitive app → no data encryption, no RLS isolation, no compliance flags", () => {
    const s = spec({ storesData: false, tenancy: "single-user", sensitiveData: ["none"], auth: "none" });
    expect(deriveSecurityPosture(s).encryptionAtRest).toContain("N/A");
    expect(deriveOperatingEnvironment(s).database).toContain("None");
    expect(deriveCompliance(s)).toEqual([]);
  });
});

describe("reviewSrs — completeness + rigor (the disposer)", () => {
  test("a complete, rigorous SRS → no blocking gaps (passes)", () => {
    const p = prd();
    expect(srsReviewVerdict(assembleSrs(p, fullDraft(p)), "2026-06-23T00:00:00.000Z").status).toBe("pass");
  });

  test("a PRD requirement with no functional requirement → coverage gap (blocks)", () => {
    const p = prd();
    const d = fullDraft(p, { functionalRequirements: [fr("FR-1", ["F1"])] }); // F2 uncovered
    expect(reviewSrs(assembleSrs(p, d)).map((f) => f.ruleId)).toContain("fr-coverage-gap");
  });

  test("a functional requirement with no I/O, or no workflow, blocks (directive #2)", () => {
    const p = prd();
    const noIo = fullDraft(p);
    noIo.functionalRequirements[0]!.inputs = [];
    noIo.functionalRequirements[0]!.outputs = [];
    expect(reviewSrs(assembleSrs(p, noIo)).map((f) => f.ruleId)).toContain("no-io-spec");
    const noFlow = fullDraft(p);
    noFlow.functionalRequirements[0]!.workflow = [];
    expect(reviewSrs(assembleSrs(p, noFlow)).map((f) => f.ruleId)).toContain("no-workflow");
  });

  test("a vague or empty NFR blocks (directive #1: exact metrics)", () => {
    const p = prd();
    const vague = fullDraft(p, { performance: { throughput: "fast", latencyP99: "< 300ms", resourceLimit: "512MB" } });
    expect(reviewSrs(assembleSrs(p, vague)).map((f) => f.ruleId)).toContain("vague-nfr");
    const empty = fullDraft(p, { performance: { throughput: "", latencyP99: "< 300ms", resourceLimit: "512MB" } });
    expect(reviewSrs(assembleSrs(p, empty)).map((f) => f.ruleId)).toContain("missing-performance-nfr");
  });

  test("an honest 'TBD' NFR backed by an open issue is allowed (deferral, not a vague guess)", () => {
    const p = prd();
    const d = fullDraft(p, {
      performance: { throughput: "TBD (see TECH-001)", latencyP99: "< 300ms", resourceLimit: "512MB" },
      openIssues: [{ ref: "TECH-001", description: "peak load unknown", module: "all" }],
    });
    expect(reviewSrs(assembleSrs(p, d)).map((f) => f.ruleId)).not.toContain("vague-nfr");
  });

  test("broken coverage ref + missing data model block; missing error states is advisory", () => {
    const p = prd();
    const badRef = fullDraft(p, { functionalRequirements: [fr("FR-1", ["F1"]), fr("FR-2", ["F9"])] });
    expect(reviewSrs(assembleSrs(p, badRef)).map((f) => f.ruleId)).toContain("broken-coverage-ref");
    const noData = fullDraft(p, { dataModel: [] });
    expect(reviewSrs(assembleSrs(p, noData)).map((f) => f.ruleId)).toContain("no-data-model");
    const noErr = fullDraft(p);
    noErr.functionalRequirements[0]!.errors = [];
    expect(reviewSrs(assembleSrs(p, noErr)).find((f) => f.ruleId === "no-error-states")?.severity).toBe("medium");
  });
});

describe("coerceSrsDraft + renderSrsMarkdown", () => {
  test("malformed → near-empty draft (loop retries, not crashes)", () => {
    const d = coerceSrsDraft("garbage");
    expect(d.functionalRequirements).toEqual([]);
    expect(d.performance).toEqual({ throughput: "", latencyP99: "", resourceLimit: "" });
  });

  test("coerces nested I/O, drops junk, assigns FR ids", () => {
    const d = coerceSrsDraft({ functionalRequirements: [{ title: "T", inputs: [{ element: "a", type: "UUID" }, { type: "no element" }], workflow: ["s", 5] }] });
    expect(d.functionalRequirements[0]!.id).toBe("FR-1");
    expect(d.functionalRequirements[0]!.inputs).toEqual([{ element: "a", type: "UUID", constraints: "", source: "" }]);
    expect(d.functionalRequirements[0]!.workflow).toEqual(["s"]);
  });

  test("renders the template incl. derived security + the I/O table + open-issues section", () => {
    const p = prd();
    const md = renderSrsMarkdown(assembleSrs(p, fullDraft(p)));
    expect(md).toContain("# Software Requirements Specification");
    expect(md).toContain("AES-256");
    expect(md).toContain("Specific Functional Requirements");
    expect(md).toContain("Open Technical Issues");
  });
});
