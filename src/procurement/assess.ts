/**
 * The deterministic core of procurement research — the safety-critical part. Given
 * factual evidence about a candidate it decides, with NO LLM and NO network, whether
 * the candidate is safe to recommend, scores it, ranks the field, and picks a
 * disposition. Pure (clock-free: staleness arrives pre-computed as `ageDays`), so it
 * is fully unit-testable and reproducible. "Evidence disposes; the LLM only narrates."
 */
import type {
  AssessedCandidate,
  Candidate,
  Capability,
  Disposition,
  Evidence,
  LicenseCategory,
  SafetyVerdict,
} from "./types.ts";

/** No release in this many days → a maintenance WARNING (not a hard block). */
const STALE_DAYS = 540; // ~18 months
/** OpenSSF Scorecard below this → a supply-chain hygiene warning. */
const LOW_SCORECARD = 4;

/**
 * Categorize an SPDX-ish license string. Conservative / fail-safe: if a strong-copyleft
 * term appears anywhere we treat the whole thing as strong-copyleft (we do not fully
 * parse `AND`/`OR` expressions — caution beats a permissive misread). Order matters:
 * AGPL/LGPL are matched before the bare "GPL" fallback; "UNLICENSED" (npm's proprietary
 * marker) before the permissive "Unlicense".
 */
export function categorizeLicense(raw: string | null): LicenseCategory {
  if (!raw || !raw.trim()) return "unknown";
  const s = raw.toUpperCase();
  const has = (frag: string) => s.includes(frag);
  if (has("AGPL") || has("SSPL")) return "strong-copyleft";
  if (has("LGPL")) return "weak-copyleft";
  if (has("MPL") || has("EPL") || has("CDDL") || has("OSL") || has("CECILL-C")) return "weak-copyleft";
  if (has("GPL") || has("EUPL")) return "strong-copyleft";
  if (has("UNLICENSED") || has("PROPRIETARY") || has("SEE LICENSE") || has("SEE-LICENSE")) return "proprietary";
  if (
    has("MIT") || has("ISC") || has("APACHE") || has("BSD") || has("0BSD") ||
    has("UNLICENSE") || has("CC0") || has("ZLIB") || has("WTFPL") || has("BLUEOAK") || has("PYTHON-2")
  ) {
    return "permissive";
  }
  return "unknown";
}

/**
 * The hard safety filter. A blocker → NOT safe to recommend. Fail-closed: no evidence
 * means we couldn't verify it, which is itself a block (an unverifiable dependency is
 * not a safe default for a non-technical operator).
 */
export function assessSafety(ev: Evidence | null): SafetyVerdict {
  if (!ev) {
    return { safe: false, blockers: ["could not verify this dependency (no license/security data) — unsafe to recommend blind"], warnings: [] };
  }
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (ev.advisories > 0) blockers.push(`${ev.advisories} known security ${ev.advisories === 1 ? "advisory" : "advisories"}`);
  if (ev.archived) blockers.push("source repository is archived (unmaintained)");
  if (ev.deprecated) blockers.push("package is marked deprecated by its author");
  if (ev.licenseCategory === "strong-copyleft") blockers.push(`${ev.license ?? "license"} is strong-copyleft — unsafe to embed in a proprietary app without legal review`);
  if (ev.licenseCategory === "proprietary") blockers.push(`${ev.license ?? "license"} is proprietary / unlicensed — usage must be cleared first`);

  if (ev.licenseCategory === "unknown") warnings.push("license could not be determined — verify before use");
  if (ev.licenseCategory === "weak-copyleft") warnings.push(`${ev.license ?? "license"} is weak-copyleft — usually fine to link, but review`);
  if (ev.ageDays !== null && ev.ageDays > STALE_DAYS) warnings.push(`no release in ~${Math.round(ev.ageDays / 30)} months — may be unmaintained`);
  if (ev.scorecard !== null && ev.scorecard < LOW_SCORECARD) warnings.push(`low OpenSSF Scorecard (${ev.scorecard.toFixed(1)}/10) — weak supply-chain hygiene`);

  return { safe: blockers.length === 0, blockers, warnings };
}

/**
 * Composite 0..100 HEALTH score — license + maintenance + adoption + hygiene. Unsafe
 * candidates score 0 (they never outrank a safe one). NOTE: this rates health, NOT
 * fitness for the app — a healthy but irrelevant package (keyword-discovered) can
 * out-score a fitting one. Relevance is the summarizer's / human's call, not the score's.
 */
export function scoreCandidate(ev: Evidence | null, safety: SafetyVerdict): number {
  if (!safety.safe || !ev) return 0;
  let s = 50;
  if (ev.ageDays !== null) s += ev.ageDays < 180 ? 15 : ev.ageDays < STALE_DAYS ? 5 : -10; // maintenance
  // adoption (npm monthly downloads): popular → boost; genuinely obscure (<100/mo) →
  // PENALTY, so a no-name package can't outrank a curated, proven service.
  if (ev.adoption !== null) s += ev.adoption >= 100_000 ? 20 : ev.adoption >= 10_000 ? 12 : ev.adoption >= 1_000 ? 5 : ev.adoption >= 100 ? 0 : -12;
  if (ev.scorecard !== null) s += Math.round((ev.scorecard - 5) * 2); // -10..+10 hygiene
  if (ev.licenseCategory === "permissive") s += 10;
  s -= safety.warnings.length * 3;
  return Math.max(0, Math.min(100, Math.round(s)));
}

/** Assess one candidate. Services are curated (in the registry because they're mature):
 *  trusted as safe, but the operator still owns the pricing/compliance/data-residency call. */
export function assess(candidate: Candidate, evidence: Evidence | null): AssessedCandidate {
  if (candidate.kind === "service") {
    return {
      candidate,
      evidence: null,
      safety: { safe: true, blockers: [], warnings: ["a paid/hosted service — you still own the pricing, data-residency, and compliance check before committing"] },
      score: 70, // curated baseline
    };
  }
  const safety = assessSafety(evidence);
  return { candidate, evidence, safety, score: scoreCandidate(evidence, safety) };
}

/** Rank a field: safe candidates first, then by score desc, stable on name. */
export function rank(assessed: AssessedCandidate[]): AssessedCandidate[] {
  return [...assessed].sort((a, b) => {
    if (a.safety.safe !== b.safety.safe) return a.safety.safe ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.candidate.name.localeCompare(b.candidate.name);
  });
}

/** Pick a disposition from a ranked field. Advisory — routes genuine judgment calls to a human. */
export function decideDisposition(cap: Capability, ranked: AssessedCandidate[]): Disposition {
  const safe = ranked.filter((c) => c.safety.safe);
  if (safe.length === 0) return "build"; // nothing safe off-the-shelf → build (gates vet the result)

  const topPackage = safe.find((c) => c.candidate.kind === "package");
  const hasService = safe.some((c) => c.candidate.kind === "service");

  if (cap.knownServices.length && hasService) {
    // a proven service exists for a commodity capability — buy is the safer default,
    // UNLESS a strong vetted OSS option is the single best thing on the board (real
    // buy-vs-build judgment → let a person weigh it).
    if (topPackage && topPackage === ranked[0] && topPackage.score >= 70) return "needs-human";
    return "buy-service";
  }
  if (topPackage && topPackage.score >= 60) return "adopt-oss";
  return "needs-human";
}

/** Deterministic prose for when no LLM summarizer is wired (offline / no key). */
export function fallbackRationale(cap: Capability, disposition: Disposition, ranked: AssessedCandidate[]): string {
  const top = ranked.find((c) => c.safety.safe);
  const head: Record<Disposition, string> = {
    "adopt-oss": top ? `Adopt the open-source option "${top.candidate.name}"${top.evidence?.license ? ` (${top.evidence.license})` : ""} — it passed the license, security, and maintenance checks.` : "Adopt a vetted open-source option.",
    "buy-service": `Use a proven ${cap.key} service (${cap.knownServices.join(" / ") || "a hosted provider"}) rather than building it.`,
    build: `Nothing safe was found off-the-shelf for ${cap.key} — build it (the security gates will vet what you build).`,
    "needs-human": `Genuine make-vs-buy call for ${cap.key} — a person should weigh the proven service against the strongest vetted open-source option.`,
  };
  const rejected = ranked.filter((c) => !c.safety.safe);
  const tail = rejected.length ? ` ${rejected.length} candidate(s) were ruled out (e.g. ${rejected[0]!.candidate.name}: ${rejected[0]!.safety.blockers[0] ?? "unverifiable"}).` : "";
  const youCheck = " You still own the cost, data-residency, and compliance decision.";
  return head[disposition] + tail + youCheck;
}
