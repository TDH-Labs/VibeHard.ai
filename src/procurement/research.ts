/**
 * The orchestrator — ties the seams together for one capability and for a whole spec.
 * For each candidate it discovers, it gathers evidence (services skip evidence — they're
 * curated), assesses safety deterministically, ranks the field, picks a disposition, and
 * asks the summarizer (or the deterministic fallback) for the prose. Pure over its
 * injected seams, so it is fully testable with fakes; the live `research` CLI wires the
 * keyless network providers + the LLM summarizer.
 */
import { assess, decideDisposition, fallbackRationale, rank } from "./assess.ts";
import type { Advisory, AssessedCandidate, Capability, CandidateSource, EvidenceProvider, Summarizer } from "./types.ts";

export interface ResearchDeps {
  candidateSource: CandidateSource;
  evidenceProvider: EvidenceProvider;
  summarizer?: Summarizer; // optional — deterministic fallback prose when absent
}

export async function researchCapability(cap: Capability, deps: ResearchDeps): Promise<Advisory> {
  const candidates = await deps.candidateSource(cap);
  const assessed: AssessedCandidate[] = [];
  for (const c of candidates) {
    const evidence = c.kind === "service" ? null : await deps.evidenceProvider(c);
    assessed.push(assess(c, evidence));
  }
  const ranked = rank(assessed);
  const disposition = decideDisposition(cap, ranked);
  // LLM writes the prose, but if it returns nothing usable we fall back to deterministic
  // prose — the operator never gets a blank recommendation.
  const summary = deps.summarizer ? (await deps.summarizer(cap, ranked)).trim() : "";
  const rationale = summary || fallbackRationale(cap, disposition, ranked);
  return { capability: cap, disposition, options: ranked, rationale };
}

export async function researchProcurement(caps: Capability[], deps: ResearchDeps): Promise<Advisory[]> {
  const out: Advisory[] = [];
  for (const cap of caps) out.push(await researchCapability(cap, deps));
  return out;
}
