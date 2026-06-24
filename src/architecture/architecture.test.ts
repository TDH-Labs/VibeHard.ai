import { describe, expect, test } from "bun:test";
import { architectureVerdict, assessSubstrateFit, buildOrder, coerceArchitecture, renderSadMarkdown, reviewArchitecture, type Architecture } from "./architecture.ts";
import type { Prd } from "../prd/index.ts";
import type { Srs } from "../srs/index.ts";

// A minimal PRD stand-in (architecture only carries it for traceability).
const prd = { spec: { name: "app" }, title: "PRD", requirements: [], nfrs: [], buyVsBuild: [] } as unknown as Prd;

// The SAD headline decisions every complete architecture must carry (reviewArchitecture blocks without them).
const sad = {
  systemOverview: "A web application on the platform substrate.",
  architecturalGoals: ["fail-closed security", "tenant isolation"],
  pattern: { name: "Serverless modular monolith", rationale: "fits the substrate and a small team", tradeoffs: "less ultimate horizontal scalability" },
  dataFlow: "REST over HTTPS; an RLS-scoped Supabase client per request.",
  dataArchitecture: { storageRationale: "Postgres + RLS is the verified boundary", schema: "create table notes (id uuid primary key);", stateManagement: "write-through to Postgres" },
};
function arch(workstreams: Architecture["workstreams"], over: Partial<Architecture> = {}): Architecture {
  return { prd, stack: "Next.js + Supabase", workstreams, ...sad, ...over };
}
const ws = (name: string, dependsOn: string[] = [], files = [`${name}.ts`], covers: string[] = []) => ({ name, responsibility: name, files, dependsOn, covers });

describe("buildOrder — topological tiers (deterministic from the graph)", () => {
  test("db → api → ui yields three ordered tiers", () => {
    const a = arch([ws("ui", ["api"]), ws("api", ["db"]), ws("db")]);
    expect(buildOrder(a).map((t) => t.map((w) => w.name))).toEqual([["db"], ["api"], ["ui"]]);
  });

  test("independent workstreams share a tier (parallel-eligible), sorted deterministically", () => {
    const a = arch([ws("ui", ["api", "auth"]), ws("api", ["db"]), ws("auth", ["db"]), ws("db")]);
    expect(buildOrder(a).map((t) => t.map((w) => w.name))).toEqual([["db"], ["api", "auth"], ["ui"]]);
  });

  test("a cycle leaves nodes unordered (buildOrder stops)", () => {
    expect(buildOrder(arch([ws("x", ["y"]), ws("y", ["x"])])).flat()).toEqual([]);
  });
});

describe("assessSubstrateFit — architect-steering (stack must be substrate-deployable)", () => {
  const archWith = (stack: string, storesData: boolean): Architecture =>
    arch([ws("db"), ws("api", ["db"])], { prd: { spec: { name: "app", storesData }, requirements: [], nfrs: [], buyVsBuild: [] } as unknown as Prd, stack });

  test("Supabase + stores data → on-substrate, no findings", () => {
    expect(reviewArchitecture(archWith("Next.js + Supabase + TypeScript + Tailwind", true))).toEqual([]);
  });

  test('the "Express + pg + React" problem → blocking stack-not-supabase', () => {
    expect(reviewArchitecture(archWith("Express + pg + React", true)).find((x) => x.ruleId === "stack-not-supabase")?.severity).toBe("high");
  });

  test("an incompatible managed backend (MongoDB / Firebase) → blocking stack-incompatible-backend", () => {
    expect(assessSubstrateFit(archWith("Express + MongoDB + React", true)).map((f) => f.ruleId)).toContain("stack-incompatible-backend");
    expect(assessSubstrateFit(archWith("Next.js + Firebase", true)).map((f) => f.ruleId)).toContain("stack-incompatible-backend");
  });

  test("a static app that stores no data needs no Supabase (not flagged)", () => {
    expect(assessSubstrateFit(archWith("Vite + React static marketing site", false))).toEqual([]);
  });
});

describe("reviewArchitecture — graph validation (the disposer)", () => {
  test("a clean, complete SAD → no findings, verdict passes", () => {
    const a = arch([ws("api", ["db"]), ws("db")]);
    expect(reviewArchitecture(a)).toEqual([]);
    expect(architectureVerdict(a, "2026-06-21T00:00:00.000Z").status).toBe("pass");
  });

  test("a cycle → blocking dependency-cycle", () => {
    expect(reviewArchitecture(arch([ws("x", ["y"]), ws("y", ["x"])])).map((f) => f.ruleId)).toContain("dependency-cycle");
    expect(architectureVerdict(arch([ws("x", ["y"]), ws("y", ["x"])])).status).toBe("block");
  });

  test("a dangling dependency → unknown-dependency", () => {
    expect(reviewArchitecture(arch([ws("api", ["ghost"])])).map((f) => f.ruleId)).toContain("unknown-dependency");
  });

  test("a workstream with no files → workstream-no-files", () => {
    expect(reviewArchitecture(arch([ws("api", [], [])])).map((f) => f.ruleId)).toContain("workstream-no-files");
  });

  test("no workstreams at all → no-workstreams", () => {
    expect(reviewArchitecture(arch([])).map((f) => f.ruleId)).toEqual(["no-workstreams"]);
  });
});

describe("reviewArchitecture — SAD completeness + traceability (§1/§2/§6)", () => {
  test("missing system overview / pattern / rationale each block", () => {
    expect(reviewArchitecture(arch([ws("db")], { systemOverview: "" })).map((f) => f.ruleId)).toContain("no-system-overview");
    expect(reviewArchitecture(arch([ws("db")], { pattern: { name: "", rationale: "r", tradeoffs: "" } })).map((f) => f.ruleId)).toContain("no-pattern");
    expect(reviewArchitecture(arch([ws("db")], { pattern: { name: "n", rationale: "", tradeoffs: "" } })).map((f) => f.ruleId)).toContain("no-pattern-rationale");
  });

  test("every SRS functional requirement must map to a component; broken refs block", () => {
    const srs = { functionalRequirements: [{ id: "FR-1" }, { id: "FR-2" }], dataModel: [] } as unknown as Srs;
    const covered = arch([ws("api", ["db"], ["api.ts"], ["FR-1", "FR-2"]), ws("db", [], ["db.sql"])], { srs });
    expect(reviewArchitecture(covered)).toEqual([]);
    const missed = arch([ws("api", ["db"], ["api.ts"], ["FR-1"]), ws("db", [], ["db.sql"])], { srs });
    expect(reviewArchitecture(missed).map((f) => f.ruleId)).toContain("component-coverage-gap");
    const broken = arch([ws("api", [], ["api.ts"], ["FR-9"])], { srs });
    expect(reviewArchitecture(broken).map((f) => f.ruleId)).toContain("broken-fr-ref");
  });

  test("with no SRS attached, traceability is skipped (a direct architectApp still works)", () => {
    expect(reviewArchitecture(arch([ws("api", ["db"]), ws("db")]))).toEqual([]);
  });
});

describe("coerceArchitecture — trust boundary", () => {
  test("malformed workstreams dropped; fields coerced; prd attached; covers defaulted", () => {
    const a = coerceArchitecture(
      { stack: "Vite", workstreams: [{ name: "ui", files: ["a.tsx", 3], dependsOn: ["api", null] }, { responsibility: "no name" }, "junk"] },
      prd,
    );
    expect(a.stack).toBe("Vite");
    expect(a.workstreams).toEqual([{ name: "ui", responsibility: "", files: ["a.tsx"], dependsOn: ["api"], covers: [] }]);
    expect(a.prd).toBe(prd);
  });

  test("garbage → empty workstreams, default stack, empty SAD sections", () => {
    expect(coerceArchitecture(null, prd)).toMatchObject({ stack: "unspecified", workstreams: [], systemOverview: "", pattern: { name: "" } });
  });
});

describe("renderSadMarkdown", () => {
  test("renders the SAD template + the traceability matrix", () => {
    const srs = { functionalRequirements: [{ id: "FR-1", title: "Auth" }], dataModel: [] } as unknown as Srs;
    const md = renderSadMarkdown(arch([ws("api", [], ["api.ts"], ["FR-1"])], { srs }));
    expect(md).toContain("# Software Architecture Document");
    expect(md).toContain("Architectural Patterns & Decisions");
    expect(md).toContain("Traceability Matrix");
    expect(md).toContain("FR-1");
  });
});
