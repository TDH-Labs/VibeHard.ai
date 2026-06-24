/**
 * SRS elaboration loop (stage 3 of the front-half). A `Specifier` proposes the software
 * requirements for a PRD; `elaborateSrs` assembles an SRS (draft + DERIVED env/security/
 * compliance) and GRILLS it against `reviewSrs` — re-specifying to clear blocking gaps,
 * bounded — until it's complete + rigorous. Pure orchestration; the LLM (elaborate-llm.ts)
 * is injected, so this is fake-testable and `reviewSrs`, not the model, decides "ready".
 */
import type { Finding } from "../types.ts";
import { isBlocking } from "../types.ts";
import type { Prd } from "../prd/index.ts";
import { assembleSrs, reviewSrs, type Srs, type SrsDraft } from "./srs.ts";

/** A Specifier PROPOSES the SRS draft (technical functional content); the loop assembles it
 *  with the DERIVED env/security/compliance and grills it via reviewSrs. */
export type Specifier = (prd: Prd, prior: { srs: Srs; gaps: Finding[] } | null) => Promise<SrsDraft>;

export interface SpecifyResult {
  srs: Srs;
  gaps: Finding[];
  ready: boolean;
  rounds: number;
}

export interface SpecifyOptions {
  specifier: Specifier;
  budget?: number;
  onStep?: (message: string) => void;
}

export async function elaborateSrs(prd: Prd, opts: SpecifyOptions): Promise<SpecifyResult> {
  const budget = Math.max(1, opts.budget ?? 3);
  let srs = assembleSrs(prd, await opts.specifier(prd, null));
  let gaps = reviewSrs(srs);
  let rounds = 1;
  while (gaps.some(isBlocking) && rounds < budget) {
    opts.onStep?.(`refining the technical spec — ${gaps.filter(isBlocking).length} detail(s) the reviewer wants firmed up; rewriting (pass ${rounds} of up to ${budget})`);
    srs = assembleSrs(prd, await opts.specifier(prd, { srs, gaps }));
    gaps = reviewSrs(srs);
    rounds++;
  }
  return { srs, gaps, ready: !gaps.some(isBlocking), rounds };
}
