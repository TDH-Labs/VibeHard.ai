/**
 * Auto-fix loop (PROJECT_BRIEF.md §15 NEXT, §18). Makes "blocked" helpful:
 * gate → if blocked, fix → re-gate → bounded retries → escalate on exhaustion.
 * The GATE disposes (decides pass/fail), never the fixer/LLM (§11). Deterministic
 * control flow; the gate runner and fixer are injectable so the loop is unit-tested
 * without Docker or an LLM.
 */
import { isBlocking, type Finding, type Gate } from "../types.ts";
import { runGate, type PipelineResult } from "../gate/index.ts";
import { buildEscalationPacket, type EscalationPacket } from "../escalation/index.ts";
import { defaultFixer, type Fixer } from "./fixer.ts";

export type GateRunner = (workspacePath: string) => Promise<PipelineResult>;

export interface AutoFixOptions {
  gate?: GateRunner;
  gates?: Gate[];
  fixer?: Fixer;
  /** Max fix→re-gate cycles before escalating (§18 retry budget). */
  budget?: number;
  now?: string;
  onStep?: (msg: string) => void;
}

export interface AutoFixResult {
  fixed: boolean;
  attempts: number;
  finalVerdicts: PipelineResult["verdicts"];
  /** Set when the budget is exhausted with the gate still blocking. */
  escalation: EscalationPacket | null;
  log: string[];
}

/** NTE — the hard not-to-exceed on fix→re-gate cycles. A flat ceiling on purpose: every
 *  loop is real token spend, so this caps maximum exposure. Progress-based stopping
 *  (below) usually exits earlier — either converged, or escalated because it's stuck. */
const DEFAULT_BUDGET = 5;

/** Stable identity of a finding, for round-over-round progress + cycle detection. */
function fingerprint(f: Finding): string {
  return `${f.tool}:${f.ruleId}:${f.file}:${f.line ?? "?"}`;
}

export async function autoFix(workspacePath: string, opts: AutoFixOptions = {}): Promise<AutoFixResult> {
  const gate: GateRunner = opts.gate ?? ((p) => runGate(p, opts.gates));
  const fixer: Fixer = opts.fixer ?? defaultFixer();
  const nte = opts.budget ?? DEFAULT_BUDGET;
  const log: string[] = [];
  const note = (m: string): void => {
    log.push(m);
    opts.onStep?.(m);
  };

  // Loop while it's WINNING (the blocking set strictly shrinks), up to the NTE ceiling.
  // Escalate EARLY when stuck rather than burning the whole budget on a wall:
  //   • cycle / no-change — the exact blocking set recurs (a fix changed nothing or oscillated);
  //   • plateau — 2 consecutive rounds without the blocking set getting smaller.
  // The GATE still disposes every round (§11); this only decides when to stop trying.
  const seen = new Set<string>(); // blocking-set signatures already encountered
  let prevCount = Infinity;
  let noProgress = 0;
  let attempts = 0;
  let stopReason = `reached the ${nte}-attempt ceiling`;

  while (attempts < nte) {
    const r = await gate(workspacePath);
    if (r.passed) {
      note(`gate green after ${attempts} fix attempt(s)`);
      return { fixed: true, attempts, finalVerdicts: r.verdicts, escalation: null, log };
    }

    const blocking = r.verdicts.flatMap((v) => v.findings).filter(isBlocking);
    const signature = blocking.map(fingerprint).sort().join("|");
    const blocked = r.verdicts.filter((v) => v.status === "block").map((v) => `${v.gate}(${v.blocking})`).join(", ");

    // stuck #1 — the same blocking set already occurred → looping won't converge.
    if (seen.has(signature)) {
      stopReason = `no progress — the same ${blocking.length} blocking finding(s) recurred (a fix changed nothing or oscillated)`;
      note(`${stopReason}; escalating early`);
      break;
    }
    // stuck #2 — two consecutive rounds without the blocking set shrinking.
    noProgress = blocking.length < prevCount ? 0 : noProgress + 1;
    if (noProgress >= 2) {
      stopReason = `no progress for 2 rounds (still ${blocking.length} blocking)`;
      note(`${stopReason}; escalating early`);
      break;
    }

    seen.add(signature);
    prevCount = blocking.length;
    attempts++;
    note(`attempt ${attempts}/${nte}: blocked by ${blocked} — applying fixes`);
    try {
      await fixer(workspacePath, r.verdicts);
    } catch (e) {
      stopReason = `the fixer errored: ${e instanceof Error ? e.message : String(e)}`;
      note(`${stopReason} — escalating`);
      break;
    }
  }

  // Final disposition (a fix may have landed in the last iteration → re-gate to be sure).
  const final = await gate(workspacePath);
  if (final.passed) {
    note(`gate green after ${attempts} fix attempt(s)`);
    return { fixed: true, attempts, finalVerdicts: final.verdicts, escalation: null, log };
  }
  note(`escalating residual findings — ${stopReason}`);
  const escalation = await buildEscalationPacket(final.verdicts, workspacePath, {
    reason: `auto-fix escalated: ${stopReason}`,
    now: opts.now,
  });
  return { fixed: false, attempts, finalVerdicts: final.verdicts, escalation, log };
}
