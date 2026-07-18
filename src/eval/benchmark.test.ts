import { describe, expect, test } from "bun:test";
import {
  formatBenchReport,
  parseAttempts,
  parseFinalBlockingGates,
  parseHeldTicket,
  parseShipUrl,
  runBenchmark,
  type BenchCase,
  type BenchDeps,
} from "./benchmark.ts";

// Log shapes below are lifted from the REAL /tmp/debug-e2e-9.log (2026-07-13) — the parsers'
// contract is the CLI's actual machine-parseable output, not an idealized format.
const E2E9_TAIL = `
  gate: ✓ sast
  gate: ✓ secrets
  gate: – rls-enforce (n/a — nothing to check)
  gate: ✗ prod-readiness (1 blocking)
  gate: ✗ verify (1 blocking)
  gate: ✓ completeness
  … attempt 3/20: blocked by sast(1), prod-readiness(1), verify(1) — applying fixes
  gate: ✓ sast
  gate: ✓ secrets
  gate: – rls-enforce (n/a — nothing to check)
  gate: ✓ prod-readiness
  gate: ✗ verify (1 blocking)
  gate: ✓ completeness

🛑 auto-fix could not resolve everything in 4 attempt(s).
  ::held esc-4836pb
   → held for human review (needs-human): ticket esc-4836pb
`;

describe("benchmark log parsers — contract with the CLI's machine-parseable markers", () => {
  test("parseHeldTicket reads '::held <id>' (the e2e-9 shape)", () => {
    expect(parseHeldTicket(E2E9_TAIL)).toBe("esc-4836pb");
    expect(parseHeldTicket("all green")).toBeNull();
  });

  test("parseAttempts reads both the held and the green phrasings", () => {
    expect(parseAttempts(E2E9_TAIL)).toBe(4);
    expect(parseAttempts("✅ gate green after 2 auto-fix attempt(s) — deploy-ready.")).toBe(2);
    expect(parseAttempts("no marker here")).toBeNull();
  });

  test("parseFinalBlockingGates returns the LAST round's blockers only — earlier rounds' sast/prod-readiness are already fixed", () => {
    expect(parseFinalBlockingGates(E2E9_TAIL)).toEqual(["verify"]);
  });

  test("a fully green final round → no blockers", () => {
    expect(parseFinalBlockingGates("  gate: ✓ sast\n  gate: ✓ verify\ndone")).toEqual([]);
  });

  test("parseShipUrl finds the deployed URL", () => {
    expect(parseShipUrl("   → live at https://pomodoro-timer-x.fly.dev (deployed)")).toBe("https://pomodoro-timer-x.fly.dev");
    expect(parseShipUrl("no url")).toBeNull();
  });
});

function deps(over: Partial<BenchDeps>): BenchDeps {
  return {
    build: async () => ({ exitCode: 0, log: "✅ gate green after 1 auto-fix attempt(s) — deploy-ready." }),
    ship: async () => ({ exitCode: 0, log: "live at https://app-x.fly.dev" }),
    probe: async () => 200,
    workspaceFor: (id) => `/tmp/bench-${id}`,
    now: (() => {
      let t = 0;
      return () => (t += 60_000);
    })(),
    ...over,
  };
}
const CASES: BenchCase[] = [{ id: "a", prompt: "app a" }, { id: "b", prompt: "app b" }];

describe("runBenchmark — build → ship → probe; only a live 2xx URL scores", () => {
  test("green build + ship + 200 probe → shipped, score counts it", async () => {
    const r = await runBenchmark(CASES, deps({}));
    expect(r.shipped).toBe(2);
    expect(r.score).toBe(1);
    expect(r.results[0]).toMatchObject({ outcome: "shipped", url: "https://app-x.fly.dev", probeStatus: 200, attempts: 1 });
  });

  test("a held build (exit 1 + ::held) → held with ticket, gates, attempts — never shipped", async () => {
    const r = await runBenchmark([CASES[0]!], deps({ build: async () => ({ exitCode: 1, log: E2E9_TAIL }) }));
    expect(r.results[0]).toMatchObject({ outcome: "held", ticket: "esc-4836pb", attempts: 4, blockingGates: ["verify"] });
    expect(r.shipped).toBe(0);
  });

  test("exit 1 with NO hold ticket → build-failed (a crash, not a reviewed hold)", async () => {
    const r = await runBenchmark([CASES[0]!], deps({ build: async () => ({ exitCode: 1, log: "build failed: Insufficient credits" }) }));
    expect(r.results[0]!.outcome).toBe("build-failed");
    expect(r.results[0]!.logTail).toContain("Insufficient credits");
  });

  test("gates green but the deploy fails → ship-failed", async () => {
    const r = await runBenchmark([CASES[0]!], deps({ ship: async () => ({ exitCode: 1, log: "fly deploy failed" }) }));
    expect(r.results[0]!.outcome).toBe("ship-failed");
  });

  test("a downloadable-tool that gates green and stops at 'ready to download' → shipped with no URL (its deliverable is the export, not a hosted URL — demanding a probe would mis-score a perfect run as ship-failed)", async () => {
    const r = await runBenchmark(
      [{ id: "csv-dedupe-cli", prompt: "a CSV cleaning tool" }],
      deps({ ship: async () => ({ exitCode: 0, log: "✅ Gates passed — ready to download. (A downloadable tool has no hosted URL to deploy to.)" }) }),
    );
    expect(r.results[0]).toMatchObject({ outcome: "shipped", url: null, probeStatus: null });
    expect(r.shipped).toBe(1);
  });

  test("deployed but the URL never answers 2xx → not-loadable (a dead URL is not a shipped app)", async () => {
    const r = await runBenchmark([CASES[0]!], deps({ probe: async () => 502 }));
    expect(r.results[0]).toMatchObject({ outcome: "not-loadable", probeStatus: 502 });
    expect(r.shipped).toBe(0);
  });

  test("a thrown build is recorded, never crashes the run — the remaining cases still execute", async () => {
    let calls = 0;
    const r = await runBenchmark(
      CASES,
      deps({
        build: async (c) => {
          calls++;
          if (c.id === "a") throw new Error("boom");
          return { exitCode: 0, log: "gate green after 1 auto-fix attempt(s)" };
        },
      }),
    );
    expect(calls).toBe(2);
    expect(r.results[0]!.outcome).toBe("build-failed");
    expect(r.results[1]!.outcome).toBe("shipped");
  });

  test("onCase streams each result as it lands (a 6-hour run must not be silent)", async () => {
    const seen: string[] = [];
    await runBenchmark(CASES, deps({ onCase: (x) => seen.push(x.id) }));
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("formatBenchReport — leads with the score (the reporting standard)", () => {
  test("first line is the score; per-case lines carry outcome, url, attempts, wall-clock", async () => {
    const r = await runBenchmark(CASES, deps({}));
    const out = formatBenchReport(r);
    expect(out.split("\n")[0]).toBe("benchmark: 2/2 shipped (target ≥8/10)");
    expect(out).toContain("https://app-x.fly.dev");
    expect(out).toContain("1.0m");
  });
});
