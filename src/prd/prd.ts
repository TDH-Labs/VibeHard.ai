/**
 * The PRD — stage 2 of the front-half (PROJECT_BRIEF.md §22): the Spec elaborated
 * into a Product Requirements Doc. Where the Spec is the grilled INTENT (what + for
 * whom + how sensitive), the PRD is the REQUIREMENTS: each feature broken into a
 * concrete requirement with testable acceptance criteria, the non-functional
 * requirements (the security posture), and the buy-vs-build advisories. An LLM
 * proposes the requirements (elaborate.ts); this module is the deterministic
 * disposer — it DERIVES the NFRs from the spec, runs buy-vs-build, and CHECKS the
 * PRD is complete before it can feed the architecture stage.
 */
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";
import { isSensitive, securityRequirements, type Spec } from "../spec/index.ts";
import { buyVsBuild, type BuyVsBuild } from "./buy-vs-build.ts";

/** One feature elaborated into a buildable requirement with "done" conditions. */
export interface Requirement {
  feature: string; // the spec feature this elaborates (links back for coverage)
  detail: string; // what it concretely entails
  acceptance: string[]; // testable acceptance criteria — how we know it's done
}

export interface Prd {
  spec: Spec; // the source spec, carried for traceability
  requirements: Requirement[];
  nfrs: string[]; // non-functional requirements (the security posture + retention)
  buyVsBuild: BuyVsBuild[]; // advisories — buy a mature service vs build it
}

/** Deterministic: the NFRs implied by the spec. The security posture (reused from the
 *  spec's `securityRequirements`) is the bulk — already consequence-framed and
 *  gate-pre-empting. The LLM never invents the security NFRs; they're derived. */
export function deriveNfrs(spec: Spec): string[] {
  return securityRequirements(spec);
}

/** Assemble a PRD from the spec + the LLM's requirements: NFRs and buy-vs-build are
 *  DERIVED here (deterministic), never trusted from the model. */
export function assemblePrd(spec: Spec, requirements: Requirement[]): Prd {
  return { spec, requirements, nfrs: deriveNfrs(spec), buyVsBuild: buyVsBuild(spec) };
}

const gap = (ruleId: string, severity: Finding["severity"], message: string): Finding => ({
  tool: "prd",
  ruleId,
  severity,
  file: "PRD",
  message,
});

/**
 * Deterministic completeness check on the elaborated PRD. Blocking (high) if the
 * requirements don't cover the spec, a requirement has no acceptance criteria, or a
 * sensitive app carries no security NFRs — any of which means it's not ready for the
 * architecture stage.
 */
export function reviewPrd(prd: Prd): Finding[] {
  const out: Finding[] = [];

  const covered = new Set(prd.requirements.map((r) => r.feature));
  const uncovered = prd.spec.features.filter((f) => !covered.has(f));
  if (uncovered.length) {
    out.push(gap("requirement-coverage-gap", "high", `These spec features have no requirement yet: ${uncovered.join("; ")}.`));
  }

  const noAccept = prd.requirements.filter((r) => r.acceptance.length === 0).map((r) => r.feature || r.detail);
  if (noAccept.length) {
    out.push(gap("no-acceptance-criteria", "high", `Requirements with no acceptance criteria (no way to tell when they're done): ${noAccept.join("; ")}.`));
  }

  if (isSensitive(prd.spec) && prd.nfrs.length === 0) {
    out.push(gap("no-nfrs", "high", "Sensitive app, but the PRD states no non-functional (security) requirements."));
  }

  return out;
}

/** Gate-style verdict for the PRD readiness check (block iff a blocking gap). */
export function prdReviewVerdict(prd: Prd, ranAt: string = new Date().toISOString()): GateVerdict {
  return verdictOf("prd", reviewPrd(prd), ranAt);
}

/** Trust boundary: coerce the LLM's requirements JSON into valid Requirement[] —
 *  drop malformed entries, coerce types, never trust the model's shape (§11). */
export function coerceRequirements(raw: unknown): Requirement[] {
  if (!Array.isArray(raw)) return [];
  const out: Requirement[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const feature = typeof o.feature === "string" ? o.feature.trim() : "";
    const detail = typeof o.detail === "string" ? o.detail.trim() : "";
    const acceptance = Array.isArray(o.acceptance)
      ? o.acceptance.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
    if (feature || detail) out.push({ feature, detail, acceptance });
  }
  return out;
}
