import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runEval, formatReport, gateScorer, type EvalCase, type EvalDeps } from "./harness.ts";

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
        { id: "a", built: true, passed: true, blockingGates: [] },
        { id: "b", built: true, passed: false, blockingGates: ["rls"] },
        { id: "c", built: false, passed: false, blockingGates: [], error: "spec not ready" },
      ],
    });
    expect(text).toContain("1/3 (33%)");
    expect(text).toContain("✅ a");
    expect(text).toContain("blocked by: rls");
    expect(text).toContain("did not build — spec not ready");
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
