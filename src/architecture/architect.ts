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
import { reviewArchitecture, type Architecture } from "./architecture.ts";

export type Architect = (prd: Prd, prior: { arch: Architecture; gaps: Finding[] } | null) => Promise<Architecture>;

export interface ArchitectResult {
  arch: Architecture;
  gaps: Finding[];
  ready: boolean;
  rounds: number;
}

export interface ArchitectOptions {
  architect: Architect;
  budget?: number;
  onStep?: (message: string) => void;
}

export async function architectApp(prd: Prd, opts: ArchitectOptions): Promise<ArchitectResult> {
  const budget = Math.max(1, opts.budget ?? 3);
  let arch = await opts.architect(prd, null);
  let gaps = reviewArchitecture(arch);
  let rounds = 1;
  while (gaps.some(isBlocking) && rounds < budget) {
    opts.onStep?.(`round ${rounds}: ${gaps.filter(isBlocking).length} architecture gap(s) — redesigning`);
    arch = await opts.architect(prd, { arch, gaps });
    gaps = reviewArchitecture(arch);
    rounds++;
  }
  return { arch, gaps, ready: !gaps.some(isBlocking), rounds };
}
