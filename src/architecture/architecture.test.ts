import { describe, expect, test } from "bun:test";
import { architectureVerdict, assessSubstrateFit, buildOrder, coerceArchitecture, reviewArchitecture, type Architecture } from "./architecture.ts";
import type { Prd } from "../prd/index.ts";

// A minimal PRD stand-in (architecture only carries it for traceability).
const prd = { spec: { name: "app" }, requirements: [], nfrs: [], buyVsBuild: [] } as unknown as Prd;

function arch(workstreams: Architecture["workstreams"]): Architecture {
  return { prd, stack: "Next.js + Supabase", workstreams };
}
const ws = (name: string, dependsOn: string[] = [], files = [`${name}.ts`]) => ({ name, responsibility: name, files, dependsOn });

describe("buildOrder — topological tiers (deterministic from the graph)", () => {
  test("db → api → ui yields three ordered tiers", () => {
    const a = arch([ws("ui", ["api"]), ws("api", ["db"]), ws("db")]);
    const tiers = buildOrder(a).map((t) => t.map((w) => w.name));
    expect(tiers).toEqual([["db"], ["api"], ["ui"]]);
  });

  test("independent workstreams share a tier (parallel-eligible), sorted deterministically", () => {
    const a = arch([ws("ui", ["api", "auth"]), ws("api", ["db"]), ws("auth", ["db"]), ws("db")]);
    const tiers = buildOrder(a).map((t) => t.map((w) => w.name));
    expect(tiers).toEqual([["db"], ["api", "auth"], ["ui"]]); // api & auth independent → same tier
  });

  test("a cycle leaves nodes unordered (buildOrder stops)", () => {
    const a = arch([ws("x", ["y"]), ws("y", ["x"])]);
    expect(buildOrder(a).flat()).toEqual([]); // neither can start
  });
});

describe("assessSubstrateFit — architect-steering (stack must be substrate-deployable)", () => {
  const archWith = (stack: string, storesData: boolean): Architecture => ({
    prd: { spec: { name: "app", storesData }, requirements: [], nfrs: [], buyVsBuild: [] } as unknown as Prd,
    stack,
    workstreams: [ws("db"), ws("api", ["db"])], // clean DAG → only substrate-fit findings, if any
  });

  test("Supabase + stores data → on-substrate, no findings", () => {
    expect(reviewArchitecture(archWith("Next.js + Supabase + TypeScript + Tailwind", true))).toEqual([]);
  });

  test('the "Express + pg + React" problem → blocking stack-not-supabase', () => {
    const findings = reviewArchitecture(archWith("Express + pg + React", true));
    const f = findings.find((x) => x.ruleId === "stack-not-supabase");
    expect(f?.severity).toBe("high"); // blocks → the architect loop re-proposes on Supabase
  });

  test("an incompatible managed backend (MongoDB / Firebase) → blocking stack-incompatible-backend", () => {
    expect(assessSubstrateFit(archWith("Express + MongoDB + React", true)).map((f) => f.ruleId)).toContain("stack-incompatible-backend");
    expect(assessSubstrateFit(archWith("Next.js + Firebase", true)).map((f) => f.ruleId)).toContain("stack-incompatible-backend");
  });

  test("a static app that stores no data needs no Supabase (not flagged)", () => {
    expect(assessSubstrateFit(archWith("Vite + React static marketing site", false))).toEqual([]);
  });
});

describe("reviewArchitecture — validation (the disposer)", () => {
  test("a clean DAG → no findings, verdict passes", () => {
    const a = arch([ws("api", ["db"]), ws("db")]);
    expect(reviewArchitecture(a)).toEqual([]);
    expect(architectureVerdict(a, "2026-06-21T00:00:00.000Z").status).toBe("pass");
  });

  test("a cycle → blocking dependency-cycle", () => {
    const ids = reviewArchitecture(arch([ws("x", ["y"]), ws("y", ["x"])])).map((f) => f.ruleId);
    expect(ids).toContain("dependency-cycle");
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

describe("coerceArchitecture — trust boundary", () => {
  test("malformed workstreams dropped; fields coerced; prd attached", () => {
    const a = coerceArchitecture(
      { stack: "Vite", workstreams: [{ name: "ui", files: ["a.tsx", 3], dependsOn: ["api", null] }, { responsibility: "no name" }, "junk"] },
      prd,
    );
    expect(a.stack).toBe("Vite");
    expect(a.workstreams).toEqual([{ name: "ui", responsibility: "", files: ["a.tsx"], dependsOn: ["api"] }]);
    expect(a.prd).toBe(prd);
  });

  test("garbage → empty workstreams, default stack", () => {
    expect(coerceArchitecture(null, prd)).toMatchObject({ stack: "unspecified", workstreams: [] });
  });
});
