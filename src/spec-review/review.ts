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
  const adversarial = opts.adversary ? await opts.adversary(bundle) : [];
  return {
    crossChecks,
    adversarial,
    blocked: crossChecks.some(isBlocking), // an LLM finding never blocks; only objective checks do
    needsHuman: adversarial.filter((a) => a.severity === "high" || a.severity === "critical"),
  };
}
