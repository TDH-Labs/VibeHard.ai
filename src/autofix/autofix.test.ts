import { describe, expect, test } from "bun:test";
import { autoFix, type GateRunner } from "./autofix.ts";
import type { Fixer } from "./fixer.ts";
import type { GateVerdict } from "../types.ts";
import type { PipelineResult } from "../gate/index.ts";

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

/** A gate that returns the given sequence of results, then repeats the last. */
function scriptedGate(seq: PipelineResult[]): GateRunner {
  let i = 0;
  return async () => seq[Math.min(i++, seq.length - 1)]!;
}
function countingFixer(): { fixer: Fixer; calls: () => number } {
  let n = 0;
  return { fixer: async () => void n++, calls: () => n };
}

describe("autoFix loop", () => {
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

  test("never fixable → escalates after the budget; fixer ran exactly budget times", async () => {
    const cf = countingFixer();
    const r = await autoFix("/ws", { gate: scriptedGate([BLOCK]), fixer: cf.fixer, budget: 3, now: ts });
    expect(r.fixed).toBe(false);
    expect(r.attempts).toBe(3);
    expect(cf.calls()).toBe(3);
    expect(r.escalation).not.toBeNull();
    expect(r.escalation!.blocking).toBeGreaterThan(0);
  });

  test("the GATE disposes, not the fixer — a fixer that does nothing still can't force green", async () => {
    const cf = countingFixer(); // no-op fixer
    const r = await autoFix("/ws", { gate: scriptedGate([BLOCK]), fixer: cf.fixer, budget: 2 });
    expect(r.fixed).toBe(false); // gate still blocks → no false success
  });

  test("a fixer that throws stops the loop and escalates (no crash)", async () => {
    const boom: Fixer = async () => {
      throw new Error("model unreachable");
    };
    const r = await autoFix("/ws", { gate: scriptedGate([BLOCK]), fixer: boom, budget: 5 });
    expect(r.fixed).toBe(false);
    expect(r.log.some((l) => l.includes("fixer error"))).toBe(true);
    expect(r.escalation).not.toBeNull();
  });
});
