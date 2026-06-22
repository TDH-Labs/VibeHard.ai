/**
 * Procurement research (§22 full advisor) — public surface. Discovers OSS + service
 * candidates, vets them on deterministic evidence (license / advisories / maintenance /
 * OpenSSF Scorecard), ranks, and summarizes for a non-technical operator. Online +
 * opt-in (keyless: npm + deps.dev); advisory only — never auto-procures, and anything
 * actually installed still passes the security gates.
 */
export type {
  Advisory,
  AssessedCandidate,
  Candidate,
  CandidateSource,
  Capability,
  Disposition,
  Evidence,
  EvidenceProvider,
  LicenseCategory,
  SafetyVerdict,
  Summarizer,
} from "./types.ts";

export { assess, assessSafety, categorizeLicense, decideDisposition, fallbackRationale, rank, scoreCandidate } from "./assess.ts";
export { capabilitiesFromSpec } from "./capabilities.ts";
export { combinedCandidateSource, npmSearchCandidateSource, registryCandidateSource } from "./candidates-npm.ts";
export { depsDevEvidenceProvider } from "./evidence-depsdev.ts";
export { llmSummarizer } from "./summarize-llm.ts";
export { researchCapability, researchProcurement, type ResearchDeps } from "./research.ts";
