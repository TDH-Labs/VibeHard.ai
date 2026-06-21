/**
 * Auto-fix loop (PROJECT_BRIEF.md §15 NEXT, §18). Makes "blocked" helpful:
 * gate → if blocked, fix → re-gate → bounded retries → escalate on exhaustion.
 * The GATE disposes (decides pass/fail), never the fixer/LLM (§11). Deterministic
 * control flow; the gate runner and fixer are injectable so the loop is unit-tested
 * without Docker or an LLM.
 */
import type { Gate } from "../types.ts";
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

const DEFAULT_BUDGET = 5;

export async function autoFix(workspacePath: string, opts: AutoFixOptions = {}): Promise<AutoFixResult> {
  const gate: GateRunner = opts.gate ?? ((p) => runGate(p, opts.gates));
  const fixer: Fixer = opts.fixer ?? defaultFixer();
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const log: string[] = [];
  const note = (m: string): void => {
    log.push(m);
    opts.onStep?.(m);
  };

  let attempts = 0;
  while (attempts < budget) {
    const r = await gate(workspacePath);
    if (r.passed) {
      note(`gate green after ${attempts} fix attempt(s)`);
      return { fixed: true, attempts, finalVerdicts: r.verdicts, escalation: null, log };
    }
    const blocked = r.verdicts.filter((v) => v.status === "block").map((v) => `${v.gate}(${v.blocking})`).join(", ");
    attempts++;
    note(`attempt ${attempts}/${budget}: blocked by ${blocked} — applying fixes`);
    try {
      await fixer(workspacePath, r.verdicts);
    } catch (e) {
      note(`fixer error: ${e instanceof Error ? e.message : String(e)} — stopping`);
      break;
    }
  }

  // Budget exhausted (or fixer errored): final disposition.
  const final = await gate(workspacePath);
  if (final.passed) {
    note(`gate green after ${attempts} fix attempt(s)`);
    return { fixed: true, attempts, finalVerdicts: final.verdicts, escalation: null, log };
  }
  note(`budget exhausted (${attempts}/${budget}) — escalating residual findings`);
  const escalation = await buildEscalationPacket(final.verdicts, workspacePath, {
    reason: "auto-fix could not resolve all gate findings within budget",
    now: opts.now,
  });
  return { fixed: false, attempts, finalVerdicts: final.verdicts, escalation, log };
}
