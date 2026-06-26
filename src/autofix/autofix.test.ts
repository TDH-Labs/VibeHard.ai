import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoFix, defaultBudgetFor, type GateRunner } from "./autofix.ts";
import type { Fixer } from "./fixer.ts";
import type { GateVerdict, Severity } from "../types.ts";
import type { PipelineResult } from "../gate/index.ts";

const budgetTmps: string[] = [];
afterEach(() => {
  for (const d of budgetTmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function wsWithFeatures(n?: number): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-budget-"));
  budgetTmps.push(d);
  if (n !== undefined) {
    mkdirSync(join(d, ".vibehard"), { recursive: true });
    writeFileSync(join(d, ".vibehard", "spec.json"), JSON.stringify({ features: Array.from({ length: n }, (_, i) => `feature ${i}`) }));
  }
  return d;
}

describe("defaultBudgetFor — attempt ceiling scales with feature count", () => {
  test("a 10-feature app gets headroom to build them one-per-round; no spec → flat base", () => {
    expect(defaultBudgetFor(wsWithFeatures(10))).toBe(30); // 10 base + 2×10
    expect(defaultBudgetFor(wsWithFeatures(0))).toBe(10);
    expect(defaultBudgetFor(wsWithFeatures(undefined))).toBe(10); // no spec
  });
});

const ts = "2026-06-21T00:00:00.000Z";
const blockVerdict: GateVerdict = {
  gate: "verify",
  status: "block",
  findings: [{ tool: "verify", ruleId: "build-failed", severity: "high", file: "package.json", message: "boom" }],
  blocking: 1,
  ranAt: ts,
};
const passVerdict: GateVerdict = { gate: "verify", status: "pass", findings: [], blocking: 0, ranAt: ts };
const BLOCK: PipelineResult = { verdicts: [blockVerdict], passed: false };
const PASS: PipelineResult = { verdicts: [passVerdict], passed: true };

/** A BLOCK result with `n` DISTINCT blocking findings (ruleIds r0..r{n-1}). */
function blockN(n: number, offset = 0): PipelineResult {
  const findings = Array.from({ length: n }, (_, i) => ({
    tool: "verify",
    ruleId: `r${offset + i}`,
    severity: "high" as Severity,
    file: "f",
    message: "x",
  }));
  return { verdicts: [{ gate: "verify", status: "block", findings, blocking: n, ranAt: ts }], passed: false };
}

/** A gate that returns the given sequence, then repeats the last. */
function scriptedGate(seq: PipelineResult[]): GateRunner {
  let i = 0;
  return async () => seq[Math.min(i++, seq.length - 1)]!;
}
/** A gate that always blocks with 2 findings but NEVER the same pair (no cycle, no shrink). */
function plateauGate(): GateRunner {
  let i = 0;
  return async () => {
    const r = blockN(2, i);
    i += 2;
    return r;
  };
}
function countingFixer(): { fixer: Fixer; calls: () => number } {
  let n = 0;
  return { fixer: async () => void n++, calls: () => n };
}

describe("autoFix loop", () => {
  test("a fixer that throws ONCE (transient stream stall) is retried, not escalated", async () => {
    let n = 0;
    const fixer: Fixer = async () => {
      n++;
      if (n === 1) throw new Error("engine driver failed: stream idle 120000ms (no token received)");
    };
    const r = await autoFix("/ws", { gate: scriptedGate([BLOCK, PASS]), fixer });
    expect(r.fixed).toBe(true); // the retry recovered the round
    expect(r.escalation).toBeNull();
    expect(n).toBe(2); // threw once, retried, succeeded
  });

  test("a fixer that throws TWICE escalates (a genuinely stuck fixer, not a blip)", async () => {
    const r = await autoFix("/ws", { gate: scriptedGate([BLOCK]), fixer: async () => { throw new Error("persistent provider outage"); } });
    expect(r.fixed).toBe(false);
    expect(r.escalation).not.toBeNull();
  });

  test("already green → no fix attempts", async () => {
    const cf = countingFixer();
    const r = await autoFix("/ws", { gate: scriptedGate([PASS]), fixer: cf.fixer });
    expect(r.fixed).toBe(true);
    expect(r.attempts).toBe(0);
    expect(cf.calls()).toBe(0);
    expect(r.escalation).toBeNull();
  });

  test("blocked then fixed → re-gates green; fixer ran once", async () => {
    const cf = countingFixer();
    const r = await autoFix("/ws", { gate: scriptedGate([BLOCK, PASS]), fixer: cf.fixer });
    expect(r.fixed).toBe(true);
    expect(r.attempts).toBe(1);
    expect(cf.calls()).toBe(1);
  });

  test("keeps looping while the blocking set SHRINKS, then converges (no early escalation)", async () => {
    const cf = countingFixer();
    const r = await autoFix("/ws", { gate: scriptedGate([blockN(3), blockN(2), blockN(1), PASS]), fixer: cf.fixer, budget: 5 });
    expect(r.fixed).toBe(true);
    expect(r.attempts).toBe(3); // 3 winning rounds, then green — progress overrides the 2-flat-round rule
    expect(r.escalation).toBeNull();
  });

  test("no progress — the SAME findings recur → escalates EARLY (cycle), does NOT burn the budget", async () => {
    const cf = countingFixer();
    const r = await autoFix("/ws", { gate: scriptedGate([BLOCK]), fixer: cf.fixer, budget: 5, now: ts });
    expect(r.fixed).toBe(false);
    expect(r.attempts).toBe(1); // one fix, then the recurrence is caught — not 5
    expect(cf.calls()).toBe(1);
    expect(r.escalation).not.toBeNull();
    expect(r.log.some((l) => /recurred|no progress/.test(l))).toBe(true);
  });

  test("fast pass → FULL verification runs; a full-only failure (clean-room/container) is fixed then re-verified", async () => {
    const cf = countingFixer();
    const r = await autoFix("/ws", {
      gate: scriptedGate([PASS]), // the cheap inner loop: always green
      fullGate: scriptedGate([BLOCK, PASS]), // the full pass: catches something the proxy can't, then green
      fixer: cf.fixer,
      budget: 5,
      now: ts,
    });
    expect(r.fixed).toBe(true);
    expect(cf.calls()).toBeGreaterThanOrEqual(1); // the full-only finding got fixed before declaring pass
  });

  test("the cheap inner loop never declares success on a fast pass alone — full verify must also pass", async () => {
    // fast always green, but full ALWAYS blocks → must NOT report fixed (no false 'pass')
    const r = await autoFix("/ws", { gate: scriptedGate([PASS]), fullGate: scriptedGate([BLOCK]), fixer: async () => {}, budget: 3, now: ts });
    expect(r.fixed).toBe(false); // correctness preserved: the full verifier still gates the pass
  });

  test("a plateau — 3 rounds without the blocking set shrinking → escalates EARLY (before NTE)", async () => {
    const cf = countingFixer();
    const r = await autoFix("/ws", { gate: plateauGate(), fixer: cf.fixer, budget: 6, now: ts });
    expect(r.fixed).toBe(false);
    expect(r.attempts).toBe(3); // escalated at the 3rd flat round, well before the 6 ceiling
    expect(r.log.some((l) => /no progress for 3 rounds/.test(l))).toBe(true);
  });

  test("steady progress that doesn't converge in time stops at the NTE ceiling (hard cap)", async () => {
    const cf = countingFixer();
    const r = await autoFix("/ws", {
      gate: scriptedGate([blockN(9), blockN(8), blockN(7), blockN(6), blockN(5), blockN(4)]),
      fixer: cf.fixer,
      budget: 5,
      now: ts,
    });
    expect(r.fixed).toBe(false);
    expect(r.attempts).toBe(5); // used the full ceiling — it WAS winning each round, just not done
    expect(r.escalation).not.toBeNull();
    expect(r.log.some((l) => /ceiling/.test(l))).toBe(true);
  });

  test("the GATE disposes, not the fixer — a no-op fixer can't force green", async () => {
    const cf = countingFixer();
    const r = await autoFix("/ws", { gate: scriptedGate([BLOCK]), fixer: cf.fixer, budget: 2 });
    expect(r.fixed).toBe(false);
  });

  test("a fixer that throws stops the loop and escalates (no crash)", async () => {
    const boom: Fixer = async () => {
      throw new Error("model unreachable");
    };
    const r = await autoFix("/ws", { gate: scriptedGate([BLOCK]), fixer: boom, budget: 5 });
    expect(r.fixed).toBe(false);
    expect(r.log.some((l) => l.includes("fixer errored"))).toBe(true);
    expect(r.escalation).not.toBeNull();
  });

  test("no human available → keeps trying (extra loops) and can still converge", async () => {
    const cf = countingFixer();
    const r = await autoFix("/ws", {
      gate: scriptedGate([BLOCK, BLOCK, BLOCK, BLOCK, PASS]),
      fixer: cf.fixer,
      budget: 10,
      humanAvailable: async () => false,
      extraBudgetNoHuman: 5,
      now: ts,
    });
    expect(r.fixed).toBe(true);
    expect(r.escalation).toBeNull();
    expect(r.log.some((l) => /no human available/.test(l))).toBe(true);
    expect(r.log.some((l) => /no-human extension/.test(l))).toBe(true);
  });

  test("no human available → exhausts the extra loops, then holds anyway (fail-closed)", async () => {
    const r = await autoFix("/ws", {
      gate: scriptedGate([BLOCK]),
      fixer: countingFixer().fixer,
      budget: 10,
      humanAvailable: async () => false,
      extraBudgetNoHuman: 5,
      now: ts,
    });
    expect(r.fixed).toBe(false);
    expect(r.escalation).not.toBeNull();
    expect(r.log.some((l) => /extra attempt 5\/5/.test(l))).toBe(true);
  });

  test("a human IS available → holds immediately, no extra loops", async () => {
    const r = await autoFix("/ws", {
      gate: scriptedGate([BLOCK]),
      fixer: countingFixer().fixer,
      budget: 10,
      humanAvailable: async () => true,
      now: ts,
    });
    expect(r.fixed).toBe(false);
    expect(r.escalation).not.toBeNull();
    expect(r.log.some((l) => /no human/.test(l))).toBe(false);
  });
});

import { verdictOf } from "../types.ts";
describe("B4 — 'fixed' requires the FULL gate (boot-probe), not just the fast build proxy", () => {
  test("fast proxy passes but full verify fails → autoFix never returns fixed:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibehard-b4-"));
    const fast: GateRunner = async () => ({ verdicts: [verdictOf("sast", [], "t")], passed: true }); // build proxy: green
    let fullCalls = 0;
    const full: GateRunner = async () => {
      fullCalls++;
      return { verdicts: [verdictOf("verify", [{ tool: "verify", ruleId: "boot-failed", severity: "high", file: "app/", message: "the app compiled but did not boot" }], "t")], passed: false };
    };
    try {
      const res = await autoFix(dir, { gate: fast, fullGate: full, fixer: async () => {}, budget: 2, humanAvailable: async () => true });
      expect(res.fixed).toBe(false); // a compiles-but-doesn't-run build is NOT "fixed"
      expect(fullCalls).toBeGreaterThan(0); // the full boot-probe verify actually ran before any verdict
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
