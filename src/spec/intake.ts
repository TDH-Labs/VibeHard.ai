/**
 * Intake — the front-half's proposing seam + grill loop (PROJECT_BRIEF.md §22).
 * An `Intake` drafts a `Spec` from the operator's prompt; `planIntake` then GRILLS
 * it against the deterministic `reviewSpec` (the disposer, §11): if the spec has
 * BLOCKING readiness gaps, the drafter is re-invoked with those gaps to resolve,
 * bounded by a budget. The loop stops when no blocking gap remains (ready) or the
 * budget is spent. Pure orchestration — the LLM impl (intake-llm.ts) is injected,
 * so this is unit-testable with a fake intake, and `reviewSpec` — not the LLM —
 * decides when the spec is ready (a fake/bad draft can never force "ready").
 */
import type { Finding } from "../types.ts";
import { isBlocking } from "../types.ts";
import { reviewSpec, type Spec } from "./spec.ts";

/** Draft or refine a PRD. `prior` carries the last draft + its blocking gaps so the
 *  drafter can resolve them (or, in an interactive surface, ask the operator). */
export type Intake = (prompt: string, prior: { spec: Spec; gaps: Finding[] } | null) => Promise<Spec>;

export interface PlanResult {
  spec: Spec;
  gaps: Finding[]; // remaining readiness findings (only advisories if `ready`)
  ready: boolean; // no BLOCKING gaps — safe to proceed to codegen
  rounds: number; // how many intake passes it took
}

export interface PlanOptions {
  intake: Intake;
  /** Max intake passes before giving up and returning the spec + its blocking gaps. */
  budget?: number;
  onStep?: (message: string) => void;
}

export async function planIntake(prompt: string, opts: PlanOptions): Promise<PlanResult> {
  const budget = Math.max(1, opts.budget ?? 3);
  let spec = await opts.intake(prompt, null);
  let gaps = reviewSpec(spec);
  let rounds = 1;
  while (gaps.some(isBlocking) && rounds < budget) {
    opts.onStep?.(`round ${rounds}: ${gaps.filter(isBlocking).length} blocking gap(s) — refining the spec`);
    spec = await opts.intake(prompt, { spec, gaps });
    gaps = reviewSpec(spec);
    rounds++;
  }
  return { spec, gaps, ready: !gaps.some(isBlocking), rounds };
}
