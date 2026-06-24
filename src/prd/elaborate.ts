/**
 * PRD elaboration loop (PROJECT_BRIEF.md §22). An `Elaborator` proposes the
 * requirements for a spec; `elaboratePrd` assembles a PRD (requirements + DERIVED
 * NFRs + buy-vs-build) and GRILLS it against `reviewPrd` — re-elaborating to fill
 * blocking gaps, bounded — until the PRD is complete. Pure orchestration: the LLM
 * (elaborate-llm.ts) is injected, so this is unit-testable with a fake, and
 * `reviewPrd`, not the model, decides "ready".
 */
import type { Finding } from "../types.ts";
import { isBlocking } from "../types.ts";
import type { Spec } from "../spec/index.ts";
import { assemblePrd, reviewPrd, type Prd, type PrdDraft } from "./prd.ts";

/** An Elaborator PROPOSES the full PRD draft (strategic + functional content); the loop
 *  assembles it with the DERIVED security/procurement halves and grills it via reviewPrd. */
export type Elaborator = (spec: Spec, prior: { prd: Prd; gaps: Finding[] } | null) => Promise<PrdDraft>;

export interface ElaborateResult {
  prd: Prd;
  gaps: Finding[];
  ready: boolean;
  rounds: number;
}

export interface ElaborateOptions {
  elaborator: Elaborator;
  budget?: number;
  onStep?: (message: string) => void;
}

export async function elaboratePrd(spec: Spec, opts: ElaborateOptions): Promise<ElaborateResult> {
  const budget = Math.max(1, opts.budget ?? 3);
  let prd = assemblePrd(spec, await opts.elaborator(spec, null));
  let gaps = reviewPrd(prd);
  let rounds = 1;
  while (gaps.some(isBlocking) && rounds < budget) {
    opts.onStep?.(`round ${rounds}: ${gaps.filter(isBlocking).length} PRD gap(s) — elaborating`);
    prd = assemblePrd(spec, await opts.elaborator(spec, { prd, gaps }));
    gaps = reviewPrd(prd);
    rounds++;
  }
  return { prd, gaps, ready: !gaps.some(isBlocking), rounds };
}
