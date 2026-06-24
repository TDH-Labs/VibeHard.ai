/**
 * Architecture loop (PROJECT_BRIEF.md §22). An `Architect` proposes the design for a
 * PRD; `architectApp` grills it against `reviewArchitecture` — redesigning to clear
 * blocking gaps (cycles, dangling deps, file-less workstreams), bounded — until it's
 * buildable. Pure orchestration; the LLM (architect-llm.ts) is injected, so this is
 * fake-testable and `reviewArchitecture`, not the model, decides "ready".
 */
import type { Finding } from "../types.ts";
import { isBlocking } from "../types.ts";
import type { Prd } from "../prd/index.ts";
import type { Srs } from "../srs/index.ts";
import { reviewArchitecture, type Architecture } from "./architecture.ts";

/** An Architect designs from the PRD, optionally enriched by the SRS (data model + interfaces +
 *  modules) when the SRS stage ran before it. The 3rd param is optional so fakes can ignore it. */
export type Architect = (prd: Prd, prior: { arch: Architecture; gaps: Finding[] } | null, srs?: Srs) => Promise<Architecture>;

export interface ArchitectResult {
  arch: Architecture;
  gaps: Finding[];
  ready: boolean;
  rounds: number;
}

export interface ArchitectOptions {
  architect: Architect;
  srs?: Srs; // when the SRS stage ran, the architect designs against its data model + interfaces
  budget?: number;
  onStep?: (message: string) => void;
}

export async function architectApp(prd: Prd, opts: ArchitectOptions): Promise<ArchitectResult> {
  const budget = Math.max(1, opts.budget ?? 3);
  let arch = await opts.architect(prd, null, opts.srs);
  let gaps = reviewArchitecture(arch);
  let rounds = 1;
  while (gaps.some(isBlocking) && rounds < budget) {
    opts.onStep?.(`refining the design — ${gaps.filter(isBlocking).length} thing(s) the checks want resolved; redrawing (pass ${rounds} of up to ${budget})`);
    arch = await opts.architect(prd, { arch, gaps }, opts.srs);
    gaps = reviewArchitecture(arch);
    rounds++;
  }
  return { arch, gaps, ready: !gaps.some(isBlocking), rounds };
}
