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

  test("build-substrate W3: onRoundComplete fires once per completed round, awaited, not on the final passing round", async () => {
    const cf = countingFixer();
    const rounds: number[] = [];
    let resolveOrder: string[] = [];
    const r = await autoFix("/ws", {
      gate: scriptedGate([blockN(3), blockN(2), blockN(1), PASS]),
      fixer: cf.fixer,
      budget: 5,
      onRoundComplete: async (round) => {
        resolveOrder.push(`start-${round}`);
        await new Promise((res) => setTimeout(res, 0)); // prove it's genuinely awaited, not fire-and-forget
        resolveOrder.push(`end-${round}`);
        rounds.push(round);
      },
    });
    expect(r.fixed).toBe(true);
    expect(rounds).toEqual([1, 2, 3]); // once per real fix round; NOT called for the round that found PASS
    expect(resolveOrder).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]); // awaited in order
  });

  test("build-substrate W3: a rejected checkpoint (onRoundComplete throws) stops the loop, matching the fail-closed contract", async () => {
    const cf = countingFixer();
    await expect(
      autoFix("/ws", {
        gate: scriptedGate([blockN(3), blockN(2), blockN(1), PASS]),
        fixer: cf.fixer,
        budget: 5,
        onRoundComplete: async (round) => {
          if (round === 2) throw new Error("checkpoint push failed");
        },
      }),
    ).rejects.toThrow("checkpoint push failed");
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

  describe("fastCheck — the cheapest tier, ahead of gate/fullGate (2026-07-21, live-loop wiring)", () => {
    test("a fastCheck failure is fixed, THEN (only once it passes) gate/fullGate legitimately run", async () => {
      const cf = countingFixer();
      const r = await autoFix("/ws", {
        fastCheck: scriptedGate([blockN(1), PASS]), // blocks once, the fixer round after "fixes" it
        gate: scriptedGate([PASS]),
        fullGate: scriptedGate([PASS]),
        fixer: cf.fixer,
        budget: 3,
        now: ts,
      });
      expect(r.fixed).toBe(true); // fastCheck passed round 2 → falls through to gate/fullGate
      expect(cf.calls()).toBe(1); // the fixer WAS invoked for the fastCheck-reported finding
    });

    test("fastCheck's blocking finding is reported under the 'fast-precheck' gate name, same shape as any other gate", async () => {
      const r = await autoFix("/ws", {
        fastCheck: scriptedGate([blockN(1)]),
        gate: async () => {
          throw new Error("must not reach the real gate while fastCheck blocks");
        },
        fixer: async () => {},
        budget: 1,
        now: ts,
      });
      expect(r.fixed).toBe(false);
      expect(r.finalVerdicts[0]!.gate).toBe("verify"); // blockN's own gate name — fastCheck here is a test double, not the real one
      expect(r.escalation?.items.length).toBeGreaterThan(0); // still escalates normally
    });

    test("a fastCheck pass falls through to gate/fullGate exactly like before this tier existed", async () => {
      const cf = countingFixer();
      const r = await autoFix("/ws", {
        fastCheck: scriptedGate([PASS]),
        gate: scriptedGate([BLOCK, PASS]),
        fixer: cf.fixer,
        budget: 3,
        now: ts,
      });
      expect(r.fixed).toBe(true);
      expect(cf.calls()).toBe(1);
    });

    test("the DEFAULT (real, non-injected) fastCheck catches a real stray-marker bug in an actual workspace, before gate/fullGate ever run", async () => {
      const ws = mkdtempSync(join(tmpdir(), "vibehard-fastcheck-live-"));
      budgetTmps.push(ws);
      writeFileSync(join(ws, "page.tsx"), "export default function Page() { return null }\n]]>");
      const explode: GateRunner = async () => {
        throw new Error("must not reach the real gate chain — the real default fastPreCheck should catch this first");
      };
      // A no-op fixer: the stray marker is never actually removed, so the REAL fastPreCheck
      // keeps blocking every round — gate/fullGate (both stubbed to throw) are never reached,
      // proving interception holds across the whole loop, not just round 1.
      const r = await autoFix(ws, { gate: explode, fullGate: explode, fixer: async () => {}, budget: 1, now: ts });
      expect(r.fixed).toBe(false);
      expect(r.finalVerdicts[0]!.gate).toBe("fast-precheck");
      expect(r.finalVerdicts[0]!.findings[0]!.ruleId).toBe("stray-marker");
      expect(r.finalVerdicts[0]!.findings[0]!.message).toContain("]]>");
    });

    test("the DEFAULT fastCheck converges once the fix actually clears it, then real gate/fullGate take over", async () => {
      const ws = mkdtempSync(join(tmpdir(), "vibehard-fastcheck-live-"));
      budgetTmps.push(ws);
      writeFileSync(join(ws, "page.tsx"), "export default function Page() { return null }\n]]>");
      let fixed = false;
      const fixer: Fixer = async () => {
        writeFileSync(join(ws, "page.tsx"), "export default function Page() { return null }\n");
        fixed = true;
      };
      // gate/fullGate return PASS unconditionally — once the marker's gone, the real fastCheck
      // passes too, so gateConfirmed legitimately reaches them (proving the tiers compose, not
      // that fastCheck alone decides "fixed").
      const r = await autoFix(ws, { gate: async () => (fixed ? PASS : BLOCK), fullGate: async () => PASS, fixer, budget: 2, now: ts });
      expect(r.fixed).toBe(true);
      expect(r.attempts).toBe(1); // one fixer round: clears the stray marker fastCheck was blocking on
    });
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

  test("2026-07-09: an exceeded wall-clock ceiling escalates the MAIN loop, even mid-progress", async () => {
    // maxDurationMs: -1 means even zero elapsed time already exceeds it — deterministic, no
    // real waiting, and immune to Date.now() millisecond-resolution ties (0 elapsed > 0 is
    // false; 0 elapsed > -1 is always true). Uses a WINNING sequence (blocking set
    // shrinking every round) that would NOT otherwise trip cycle/plateau/NTE detection, to
    // prove the ceiling is a genuinely independent outer bound, not a restatement of those.
    const cf = countingFixer();
    const r = await autoFix("/ws", { gate: scriptedGate([blockN(3), blockN(2), blockN(1), PASS]), fixer: cf.fixer, budget: 10, maxDurationMs: -1, now: ts });
    expect(r.fixed).toBe(false);
    expect(r.attempts).toBe(0); // caught before the very first round ever ran
    expect(cf.calls()).toBe(0);
    expect(r.escalation).not.toBeNull();
    expect(r.log.some((l) => /wall-clock ceiling/.test(l))).toBe(true);
  });

  test("2026-07-09: an exceeded wall-clock ceiling also stops the no-human EXTENSION phase", async () => {
    // The exact phase the live 2026-07-09 incident was sitting in when it went silent — it had
    // no wall-clock check of its own before this fix. budget: 1 forces the main loop to exit
    // into the extension phase after one round (BLOCK doesn't converge in 1 attempt); the
    // extension's own ceiling check must then catch it, not run all `extraBudgetNoHuman` rounds.
    const cf = countingFixer();
    const r = await autoFix("/ws", {
      gate: scriptedGate([BLOCK]),
      fixer: cf.fixer,
      budget: 1,
      humanAvailable: async () => false,
      extraBudgetNoHuman: 5,
      maxDurationMs: -1,
      now: ts,
    });
    expect(r.fixed).toBe(false);
    expect(r.escalation).not.toBeNull();
    expect(r.log.some((l) => /wall-clock ceiling during extension/.test(l))).toBe(true);
    expect(r.log.some((l) => /5 extra no-human attempt\(s\) also failed/.test(l))).toBe(false); // accurate: not all 5 ran
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

  test("THE BUG THIS CLOSES: onRoundComplete ALSO fires during the no-human extension phase, not just the main loop", async () => {
    const rounds: number[] = [];
    const r = await autoFix("/ws", {
      gate: scriptedGate([BLOCK]), // same signature every round → main loop's cycle-detector exits after round 1
      fixer: countingFixer().fixer,
      budget: 10,
      humanAvailable: async () => false,
      extraBudgetNoHuman: 5,
      now: ts,
      onRoundComplete: async (round) => {
        rounds.push(round);
      },
    });
    expect(r.fixed).toBe(false);
    expect(r.attempts).toBe(6); // 1 main-loop round + 5 extension rounds
    // Before this fix, `rounds` would have been [1] — the extension's 5 rounds silently
    // unchecked. A BuildWorker relying on this for per-round checkpointing (build-substrate
    // W3) would push to Tigris and check for a stop request exactly once, then run 5 more
    // rounds with neither — found live 2026-07-12 while verifying multi-round behavior before
    // a real test.
    expect(rounds).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("an EXTENSION-round fix that shrinks protected surface is rejected as tampering (found live 2026-07-05)", async () => {
    // The no-human extension used to apply fixes with NO anti-tamper check — a fixer could
    // delete a property test there and a green re-gate would be ACCEPTED. This pins the fix:
    // benign fix in the main loop, then the extension-round fix deletes tests/properties/f1 —
    // the round must be rejected, the loop must hold, and the gate must never see the tampered
    // tree as a candidate pass.
    const dir = wsWithFeatures(0);
    mkdirSync(join(dir, "tests", "properties"), { recursive: true });
    writeFileSync(join(dir, "tests/properties/f1.test.ts"), "// @requirement F1\nfc.assert(x, { seed: 42 });\n");
    let calls = 0;
    let gatedAfterTamper = false;
    const fixer: Fixer = async () => {
      calls++;
      if (calls >= 2) rmSync(join(dir, "tests/properties/f1.test.ts"), { force: true }); // the extension-round move
    };
    const gate: GateRunner = async () => {
      if (calls >= 2) gatedAfterTamper = true; // any gate look at the tampered tree would be it
      return BLOCK;
    };
    const r = await autoFix(dir, { gate, fixer, budget: 1, humanAvailable: async () => false, extraBudgetNoHuman: 3, now: ts });
    expect(r.fixed).toBe(false);
    expect(r.escalation).not.toBeNull();
    expect(r.log.some((l) => /REJECTED as tampering/.test(l) && /property test was DELETED/.test(l))).toBe(true);
    expect(gatedAfterTamper).toBe(false); // rejected BEFORE re-gating — a gamed green is unreachable
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
