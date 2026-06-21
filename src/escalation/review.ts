/**
 * Review triage (PROJECT_BRIEF.md §11 "Severity / true-positive triage →
 * Deterministic-biased: block by default; downgrade only with justification,
 * never silent skip"). The human supplies the verdict; this code applies it
 * deterministically.
 *
 * A blocking finding leaves the queue only two ways:
 *   • fixed   — the engineer changed the code → resume RE-GATES; the gate, not the
 *               human, confirms the fix (so "fixed" produces no waiver here).
 *   • approved+justification — judged a false positive / accepted risk → a Waiver
 *               that downgrades exactly that finding, recorded for audit.
 * Anything else (rejected, or approved with no justification) stays blocking.
 */
import type { Finding, GateVerdict } from "../types.ts";
import { isBlocking } from "../types.ts";
import { findingRef } from "./packet.ts";

export type ReviewVerdict = "approved" | "rejected" | "fixed";

export interface ReviewDecision {
  ref: string; // findingRef of the finding being decided
  verdict: ReviewVerdict;
  reviewer: string; // who decided — audit trail
  justification?: string; // REQUIRED for "approved"; ignored otherwise
  decidedAt: string; // ISO
}

export interface Waiver {
  ref: string;
  reviewer: string;
  justification: string;
  waivedAt: string;
}

/**
 * Turn decisions into waivers. ONLY a justified "approved" yields a waiver;
 * an "approved" with no justification is surfaced in `invalid` (never silently
 * honored), and fixed/rejected produce no waiver.
 */
export function waiversFromDecisions(decisions: ReviewDecision[]): { waivers: Waiver[]; invalid: ReviewDecision[] } {
  const waivers: Waiver[] = [];
  const invalid: ReviewDecision[] = [];
  for (const d of decisions) {
    if (d.verdict !== "approved") continue;
    const justification = d.justification?.trim();
    if (justification) {
      waivers.push({ ref: d.ref, reviewer: d.reviewer, justification, waivedAt: d.decidedAt });
    } else {
      invalid.push(d);
    }
  }
  return { waivers, invalid };
}

export interface WaivedResult {
  /** Verdicts with status/blocking recomputed ignoring waived findings. All
   *  findings are retained on each verdict — a waiver downgrades, it never deletes. */
  verdicts: GateVerdict[];
  passed: boolean;
  /** The blocking findings a justified human waived — kept for the audit record. */
  waived: Finding[];
}

/**
 * Recompute verdicts as if each waived finding no longer blocks. A waiver matched
 * to a non-blocking finding is a no-op. Pure.
 */
export function applyWaivers(verdicts: GateVerdict[], waivers: Waiver[]): WaivedResult {
  const waivedRefs = new Set(waivers.map((w) => w.ref));
  const waived: Finding[] = [];

  const adjusted = verdicts.map((v): GateVerdict => {
    let blocking = 0;
    for (const f of v.findings) {
      const blocks = isBlocking(f);
      if (waivedRefs.has(findingRef(f))) {
        if (blocks) waived.push(f);
        continue;
      }
      if (blocks) blocking++;
    }
    return { ...v, blocking, status: blocking > 0 ? "block" : "pass" };
  });

  return { verdicts: adjusted, passed: adjusted.every((v) => v.status === "pass"), waived };
}
