import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval, formatReport, gateScorer, layeredGateScorer, type EvalCase, type EvalDeps } from "./harness.ts";

const corpus: EvalCase[] = [
  { id: "a", prompt: "app a" },
  { id: "b", prompt: "app b" },
  { id: "c", prompt: "app c" },
];

describe("runEval — scoring + aggregation (fake build/gate, zero tokens)", () => {
  test("success rate = passed / total; per-case results carry blocking gates", async () => {
    const deps: EvalDeps = {
      build: async (_p, id) => ({ dir: `/built/${id}` }),
      // a passes; b blocks on rls; c blocks on sast+secrets
      gate: async (dir) =>
        dir.endsWith("/a")
          ? { passed: true, blockingGates: [] }
          : dir.endsWith("/b")
            ? { passed: false, blockingGates: ["rls"] }
            : { passed: false, blockingGates: ["sast", "secrets"] },
    };
    const r = await runEval(corpus, deps);
    expect(r.total).toBe(3);
    expect(r.passed).toBe(1);
    expect(r.successRate).toBeCloseTo(1 / 3);
    expect(r.results.find((x) => x.id === "b")?.blockingGates).toEqual(["rls"]);
    expect(r.results.find((x) => x.id === "c")?.blockingGates).toEqual(["sast", "secrets"]);
  });

  test("a build that produces no workspace is a 0, recorded with a reason (never a crash)", async () => {
    const deps: EvalDeps = {
      build: async () => ({ dir: null, error: "spec not ready" }),
      gate: async () => ({ passed: true, blockingGates: [] }),
    };
    const r = await runEval([{ id: "x", prompt: "p" }], deps);
    expect(r.successRate).toBe(0);
    expect(r.results[0]).toMatchObject({ id: "x", built: false, passed: false, error: "spec not ready" });
  });

  test("a thrown build/gate is caught → non-pass, the run still completes", async () => {
    const deps: EvalDeps = {
      build: async (_p, id) => {
        if (id === "boom") throw new Error("pipeline exploded");
        return { dir: `/built/${id}` };
      },
      gate: async () => ({ passed: true, blockingGates: [] }),
    };
    const r = await runEval([{ id: "boom", prompt: "p" }, { id: "ok", prompt: "p" }], deps);
    expect(r.total).toBe(2);
    expect(r.passed).toBe(1); // ok passed; boom recorded as error
    expect(r.results.find((x) => x.id === "boom")?.error).toMatch(/exploded/);
  });

  test("empty corpus → 0% (no divide-by-zero)", async () => {
    const r = await runEval([], { build: async () => ({ dir: "/x" }) });
    expect(r.successRate).toBe(0);
    expect(r.total).toBe(0);
  });

  test("formatReport renders a pass, a block, and a no-build distinctly", () => {
    const text = formatReport({
      total: 3,
      passed: 1,
      successRate: 1 / 3,
      results: [
        { id: "a", built: true, passed: true, blockingGates: [], missingFeatures: [], partialFeatures: [] },
        { id: "b", built: true, passed: false, blockingGates: ["rls"], missingFeatures: [], partialFeatures: [] },
        { id: "c", built: false, passed: false, blockingGates: [], missingFeatures: [], partialFeatures: [], error: "spec not ready" },
      ],
    });
    expect(text).toContain("1/3 (33%)");
    expect(text).toContain("✅ a");
    expect(text).toContain("blocked by: rls");
    expect(text).toContain("did not build — spec not ready");
  });
});

describe("runEval — mustImplement feature-coverage scoring (2026-07-09: was declared, never wired)", () => {
  const baseDeps = (): Pick<EvalDeps, "build" | "gate"> => ({
    build: async (_p, id) => ({ dir: `/built/${id}` }),
    gate: async () => ({ passed: true, blockingGates: [] }),
  });

  test("gates pass but a mustImplement feature is missing → the case fails, feature named", async () => {
    const deps: EvalDeps = {
      ...baseDeps(),
      functionalCheck: async () => [{ feature: "per-user tasks", status: "missing", note: "no auth check on the tasks query" }],
    };
    const r = await runEval([{ id: "todo", prompt: "p", mustImplement: ["per-user tasks"] }], deps);
    expect(r.results[0]).toMatchObject({ passed: false, missingFeatures: ["per-user tasks"] });
    expect(r.successRate).toBe(0);
  });

  test("a 'partial' feature is surfaced but does NOT block passed", async () => {
    const deps: EvalDeps = {
      ...baseDeps(),
      functionalCheck: async () => [{ feature: "notes", status: "partial", note: "notes exist but can't be edited" }],
    };
    const r = await runEval([{ id: "crm", prompt: "p", mustImplement: ["notes"] }], deps);
    expect(r.results[0]).toMatchObject({ passed: true, partialFeatures: ["notes"], missingFeatures: [] });
  });

  test("no mustImplement declared → functionalCheck is never called, gate result alone decides", async () => {
    let called = false;
    const deps: EvalDeps = { ...baseDeps(), functionalCheck: async () => ((called = true), []) };
    const r = await runEval([{ id: "x", prompt: "p" }], deps);
    expect(called).toBe(false);
    expect(r.results[0]?.passed).toBe(true);
  });

  test("a gate-blocked app never runs the functional check (nothing worth reading)", async () => {
    let called = false;
    const deps: EvalDeps = {
      build: async (_p, id) => ({ dir: `/built/${id}` }),
      gate: async () => ({ passed: false, blockingGates: ["sast"] }),
      functionalCheck: async () => ((called = true), []),
    };
    const r = await runEval([{ id: "x", prompt: "p", mustImplement: ["a"] }], deps);
    expect(called).toBe(false);
    expect(r.results[0]?.passed).toBe(false);
  });

  test("the functional check's OWN failure fails OPEN — never blocks the case, surfaced separately", async () => {
    const deps: EvalDeps = {
      ...baseDeps(),
      functionalCheck: async () => {
        throw new Error("reviewer model unavailable");
      },
    };
    const r = await runEval([{ id: "x", prompt: "p", mustImplement: ["a"] }], deps);
    expect(r.results[0]).toMatchObject({ passed: true, missingFeatures: [], featureCheckError: "reviewer model unavailable" });
  });

  test("formatReport names missing features and flags a feature-check error distinctly", () => {
    const text = formatReport({
      total: 1,
      passed: 0,
      successRate: 0,
      results: [{ id: "todo", built: true, passed: false, blockingGates: [], missingFeatures: ["per-user tasks"], partialFeatures: [], featureCheckError: undefined }],
    });
    expect(text).toContain("missing: per-user tasks");
  });
});

describe("layeredGateScorer — fast checks fail FAST, before the real (expensive) gate chain", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("a stray marker fails immediately — no real gate chain ever runs", async () => {
    const ws = mkdtempSync(join(tmpdir(), "vibehard-layered-"));
    dirs.push(ws);
    writeFileSync(join(ws, "app.ts"), "export const ok = 1;\n]]>");
    const r = await layeredGateScorer(ws);
    expect(r.passed).toBe(false);
    expect(r.blockingGates).toEqual(["fast:stray-marker"]);
  });

  test("a migration hallucinating a table as a view fails fast, same shape as the live incident", async () => {
    const ws = mkdtempSync(join(tmpdir(), "vibehard-layered-"));
    dirs.push(ws);
    writeFileSync(join(ws, "app.ts"), "export const ok = 1;\n");
    const migrationsDir = join(ws, "supabase", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(join(migrationsDir, "0001_teams.sql"), "create table teams (id uuid primary key);");
    writeFileSync(join(migrationsDir, "0002_alias.sql"), "alter view teams rename to team_alias;");
    const r = await layeredGateScorer(ws);
    expect(r.passed).toBe(false);
    expect(r.blockingGates).toEqual(["fast:migration-ddl"]);
  });
});

// Integration: score the REAL fixtures through the REAL gate chain (needs Docker for the scanners).
// Proves the default gateScorer + harness agree with the known-good/known-bad fixtures, no tokens.
const FIXTURES = join(import.meta.dir, "..", "..", "fixtures");
const run = process.env.VIBEHARD_INTEGRATION ? describe : describe.skip;
run("runEval — real gate chain over known fixtures (Docker)", () => {
  test("remediated fixture passes, vulnerable fixture blocks → 50% success", async () => {
    const deps: EvalDeps = {
      build: async (_p, id) => ({ dir: join(FIXTURES, id === "good" ? "remediated" : "vulnerable") }),
      gate: gateScorer,
    };
    const r = await runEval([{ id: "good", prompt: "secure app" }, { id: "bad", prompt: "vulnerable app" }], deps);
    expect(r.results.find((x) => x.id === "good")?.passed).toBe(true);
    expect(r.results.find((x) => x.id === "bad")?.passed).toBe(false);
    expect(r.successRate).toBeCloseTo(0.5);
  }, 180_000);
});
