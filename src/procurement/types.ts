/**
 * Procurement research (PROJECT_BRIEF.md §22, the "full advisor") — the make-vs-buy
 * step that ACTUALLY LOOKS. Where buy-vs-build is a static registry ("does a commodity
 * category match?"), this discovers real candidates (OSS packages + curated services),
 * gathers DETERMINISTIC evidence about each (license, maintenance, known advisories,
 * supply-chain hygiene), filters on objective safety, ranks, and — only then — lets an
 * LLM summarize the vetted shortlist into a plain-English recommendation for a
 * non-technical operator.
 *
 * Architecture mirrors the rest of VibeHard:
 *   • Pure deterministic core (assess.ts) — the safety-critical part; fully unit-tested.
 *   • Injectable I/O seams (below) — discovery / evidence / summary — each with a fake.
 *   • LLM PROPOSES the prose; deterministic evidence DISPOSES safety (§11). The gates
 *     (depvuln/sast/secrets) remain the backstop on anything actually installed — a
 *     recommendation is suggested, never trusted.
 *   • ONLINE + OPT-IN: this calls out to the network (keyless: npm + deps.dev/OSV), so
 *     it lives OUTSIDE the deterministic gate chain — a `vibehard research` advisory, not
 *     a deploy gate. It NEVER auto-procures or auto-installs.
 */

/** Coarse license buckets — the axis that decides "safe to embed in a customer's app". */
export type LicenseCategory =
  | "permissive" // MIT/ISC/Apache/BSD — safe to embed
  | "weak-copyleft" // LGPL/MPL — usually fine to link, review
  | "strong-copyleft" // GPL/AGPL/SSPL — unsafe to embed in a proprietary app
  | "proprietary" // UNLICENSED / "see license" — must be cleared
  | "unknown"; // couldn't determine — treat with caution

/** The advisory's headline call for a capability. Advisory only — a human disposes. */
export type Disposition =
  | "adopt-oss" // a vetted open-source package leads
  | "buy-service" // a mature paid/hosted service is the safer default
  | "build" // nothing safe off-the-shelf → build it (the gates will vet the result)
  | "needs-human"; // a genuine judgment call (e.g. strong OSS vs a proven service)

/** A capability the app needs — the unit of research. Derived from the spec/PRD. */
export interface Capability {
  key: string; // "payments", "pdf-generation"
  need: string; // plain description of what it must do
  searchTerms: string[]; // terms used to discover OSS candidates
  knownServices: string[]; // curated paid/hosted services for the buy side (may be empty)
}

/** A way to satisfy a capability — an OSS package or a paid service. */
export interface Candidate {
  kind: "package" | "service";
  name: string; // "pdfkit" | "Stripe"
  source: "registry" | "npm-search";
  ecosystem?: string; // "npm" for packages
  description?: string;
  repoUrl?: string;
  homepage?: string;
}

/** Deterministic, factual evidence about a candidate (from deps.dev / npm / OSV). */
export interface Evidence {
  license: string | null; // SPDX id as reported
  licenseCategory: LicenseCategory;
  lastReleaseISO: string | null;
  ageDays: number | null; // days since last release (provider computes vs. now)
  deprecated: boolean;
  archived: boolean;
  advisories: number; // count of known security advisories (OSV / deps.dev)
  scorecard: number | null; // OpenSSF Scorecard overall score, 0..10
  adoption: number | null; // adoption proxy — npm downloads in the last month (null when unavailable)
}

/** Deterministic safety filter result — objective, not the LLM's opinion. */
export interface SafetyVerdict {
  safe: boolean; // passes the hard filters?
  blockers: string[]; // why it's unsafe (license/vuln/archived/deprecated/unverifiable)
  warnings: string[]; // non-blocking concerns to surface
}

/** A candidate with its evidence, safety verdict, and composite score. */
export interface AssessedCandidate {
  candidate: Candidate;
  evidence: Evidence | null; // null for services / when evidence couldn't be gathered
  safety: SafetyVerdict;
  score: number; // 0..100 composite (0 when unsafe)
}

/** The advisor's output for one capability. */
export interface Advisory {
  capability: Capability;
  disposition: Disposition;
  options: AssessedCandidate[]; // ranked: safe first, then by score desc
  rationale: string; // plain-English (LLM) or deterministic fallback
}

// ── seams (injectable I/O — each has a fake in tests, a live impl for `research`) ──

/** Discover candidates for a capability (registry services + OSS search). */
export type CandidateSource = (cap: Capability) => Promise<Candidate[]>;

/** Gather deterministic evidence for one candidate. Returns null if unobtainable. */
export type EvidenceProvider = (candidate: Candidate) => Promise<Evidence | null>;

/** Turn a vetted, ranked shortlist into operator-facing prose. LLM-backed (advisory). */
export type Summarizer = (cap: Capability, ranked: AssessedCandidate[]) => Promise<string>;
