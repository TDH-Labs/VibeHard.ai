/**
 * Adversarial front-half review (docs: "the front-half's missing adversary"). The
 * front-half has a proposer (the LLM) and per-stage completeness linters; this adds the
 * adversary — something that tries to find what's WRONG with a well-formed plan before
 * it's built. Two layers, matching §11:
 *   • `crossCheck` — OBJECTIVE spec↔PRD↔architecture consistency rules → can BLOCK.
 *   • the `Adversary` seam — an LLM red-team (judgment) → ADVISORY; it surfaces risks and
 *     routes the serious ones to a human. An LLM never auto-blocks the plan.
 *
 * Pure orchestration; the adversary is injected (fake-testable). The deterministic
 * cross-checks, not the LLM, decide whether the plan is blocked.
 */
import type { Finding } from "../types.ts";
import { isBlocking } from "../types.ts";
import type { Spec } from "../spec/index.ts";
import type { Prd } from "../prd/index.ts";
import type { Architecture } from "../architecture/index.ts";
import { crossCheck } from "./crosscheck.ts";

export interface FrontHalfBundle {
  spec: Spec;
  prd: Prd;
  architecture: Architecture;
}

/** Adversarially review a plan → advisory risk findings. The judgment half (LLM impl in
 *  adversary-llm.ts; tests inject a fake). It SURFACES; it never blocks. */
export type Adversary = (bundle: FrontHalfBundle) => Promise<Finding[]>;

export interface FrontHalfReview {
  crossChecks: Finding[]; // deterministic; high/critical → blocks
  adversarial: Finding[]; // LLM red-team; advisory, surfaced
  blocked: boolean; // determined ONLY by the cross-checks (§11)
  needsHuman: Finding[]; // adversarial findings serious enough to route to a human
}

export async function reviewFrontHalf(bundle: FrontHalfBundle, opts: { adversary?: Adversary } = {}): Promise<FrontHalfReview> {
  const crossChecks = crossCheck(bundle.spec, bundle.prd, bundle.architecture);
  let adversarial: Finding[] = [];
  if (opts.adversary) {
    try {
      adversarial = await opts.adversary(bundle);
    } catch (e) {
      // The adversary is advisory by design — "an LLM finding never blocks" (§11, see the
      // `blocked` field below). A transient provider hiccup in the red-team call (exhausted
      // retries on a whitespace-degenerate response, a timeout) must not be able to crash the
      // WHOLE build over a check that was never allowed to block it in the first place — that
      // would throw away spec/PRD/SRS/SAD work that already finished (observed live 2026-07-09:
      // 3 exhausted retries on the review-stage model killed a resumed build past that point).
      // Fail open: skip the red-team pass for this run and say so, rather than say nothing.
      adversarial = [{ tool: "spec-review", ruleId: "adversary-unavailable", severity: "low", file: "front-half", message: `adversarial review skipped — the reviewer model failed: ${e instanceof Error ? e.message : String(e)}` }];
    }
  }
  return {
    crossChecks,
    adversarial,
    blocked: crossChecks.some(isBlocking), // an LLM finding never blocks; only objective checks do
    needsHuman: adversarial.filter((a) => a.severity === "high" || a.severity === "critical"),
  };
}
