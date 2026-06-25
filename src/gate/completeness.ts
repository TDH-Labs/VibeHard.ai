/**
 * The COMPLETENESS gate (backlog §18 verify-contract): does the app actually implement the
 * features the user asked for? The other gates prove it BUILDS and is SAFE — none proves it's
 * DONE. A secure app that ships 1 of 10 promised features passes all of them; this is the gate
 * that makes "passes" mean "complete", not just "compiles safely".
 *
 * It reuses the functional reviewer (an LLM reads the spec's features vs the code, per-feature)
 * but, unlike the advisory `functest`, it BLOCKS on a feature that is entirely MISSING — and the
 * finding is actionable, so the auto-fix loop's next pass GENERATES the missing feature (wired to
 * the schema, which planning already produced). Only `missing` blocks (the clearest signal); a
 * `partial` feature is surfaced but doesn't block (an LLM's "partial" judgment is too subjective
 * to gate a deploy on). No spec / no features / reviewer unavailable → not applicable, no block.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";
import { llmFunctionalReviewer, type FunctionalReviewer } from "../functest/functest.ts";

// Feature-name words that carry no signal about WHICH feature it is — they appear in many features,
// so a match on them would let a genuinely-missing feature slip through. Distinctiveness comes from
// the domain noun (immunization, billing, attendance, …), not these.
const FEATURE_STOPWORDS = new Set([
  "and", "the", "for", "with", "management", "managing", "tracking", "track", "system", "records",
  "record", "page", "pages", "feature", "features", "support", "processing", "sharing", "scheduling",
  "schedule", "details", "detail", "data", "info", "information", "user", "users", "app",
]);

/** Deterministic guard against the reviewer's false negatives: does a feature the LLM called
 *  "missing" actually have a plausibly-matching implementation on disk? The grader is noisiest on
 *  features WITHOUT a dedicated route — "payment processing" lives inside billing, "role-based
 *  access control" in middleware/lib — so it intermittently calls them missing. But a feature's
 *  DISTINCTIVE domain word(s) (payment, immunization, staff…; generic words like "management"/
 *  "tracking"/"records" are stopworded) show up in the code that implements it — in a file PATH
 *  (a route/module named for it) or, for a folded-in feature, in file CONTENT. If a distinctive
 *  token appears either place, the feature is present (≠ entirely missing, which is all this gate
 *  blocks on). A truly-absent feature has its domain term nowhere in the code → still blocks. */
function looksImplemented(feature: string, projectPath: string): boolean {
  const tokens = (feature.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter((t) => !FEATURE_STOPWORDS.has(t));
  if (!tokens.length) return false; // no distinctive token to match on → can't vindicate; trust the LLM
  let budget = 600_000; // bound the content scan (≈ the reviewer's own source cap)
  for (const sub of ["app", "lib", "components"]) {
    const root = join(projectPath, sub);
    if (!existsSync(root)) continue;
    for (const rel of new Glob("**/*.{ts,tsx,js,jsx,sql}").scanSync({ cwd: root, dot: false })) {
      if (tokens.some((t) => rel.toLowerCase().includes(t))) return true; // a route/module named for the feature
      if (budget <= 0) continue;
      try {
        const code = readFileSync(join(root, rel), "utf8");
        budget -= code.length;
        const hay = code.toLowerCase();
        if (tokens.some((t) => hay.includes(t))) return true; // the feature's domain term appears in the code
      } catch {
        /* unreadable → skip */
      }
    }
  }
  return false;
}

export interface CompletenessOptions {
  reviewer?: FunctionalReviewer; // injectable for tests
  ranAt?: string;
}

export async function runCompleteness(projectPath: string, opts: CompletenessOptions = {}): Promise<GateVerdict> {
  const ranAt = opts.ranAt ?? new Date().toISOString();
  const specPath = join(projectPath, ".vibehard", "spec.json");
  if (!existsSync(specPath)) return verdictOf("completeness", [], ranAt); // didn't go through planning → N/A

  let features: string[] = [];
  try {
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as { features?: string[] };
    features = (spec.features ?? []).map((f) => String(f).trim()).filter(Boolean);
  } catch {
    return verdictOf("completeness", [], ranAt);
  }
  if (!features.length) return verdictOf("completeness", [], ranAt);

  const reviewer = opts.reviewer ?? llmFunctionalReviewer();
  let checks;
  try {
    checks = await reviewer(features, projectPath);
  } catch (e) {
    // The reviewer was asked to judge real features but produced nothing usable (model outage, or
    // a reasoning model that emitted no JSON even after retry). For a CORRECTNESS gate, "couldn't
    // verify" must NOT pass — that's how a build silently ships incomplete. Fail CLOSED with a
    // DISTINCT ruleId so the auto-fix loop treats this as an infra retry/hold, not a feature to
    // build (there's no missing feature to generate here — the judgment itself failed).
    const message = `Could not verify feature completeness — the functional reviewer returned no usable result (${e instanceof Error ? e.message : String(e)}). This is a reviewer/infra problem, NOT a code change: re-run the gate; if it persists a human must check the reviewer model/credentials before this build is declared complete. Failing closed so an unverifiable build is never called "done".`;
    return verdictOf("completeness", [{ tool: "completeness", ruleId: "completeness-unverified", severity: "high", file: "app/", message }], ranAt);
  }
  if (!checks.length) return verdictOf("completeness", [], ranAt); // genuine N/A (no app sources to read) → don't block

  // Only an entirely-MISSING feature blocks — but guard the reviewer's FALSE NEGATIVES: the LLM's
  // "missing" verdict varies on a nested/borderline feature (observed: "immunization & health
  // records" was implemented under children/[id]/health-records + lib/health-records.ts, yet graded
  // "missing" on one run and "present" the next — which kept a genuinely-complete app from
  // converging). File/route existence is DETERMINISTIC, so if a feature the LLM called "missing"
  // actually has a plausibly-matching implementation on disk, it is NOT missing (at most partial,
  // which doesn't block). A truly-absent feature matches nothing → still blocks.
  const findings: Finding[] = checks
    .filter((c) => c.status === "missing" && !looksImplemented(c.feature, projectPath))
    .map((c) => ({
      tool: "completeness",
      ruleId: "feature-missing",
      severity: "high",
      file: "app/",
      message: `The app is missing a feature the user explicitly asked for: "${c.feature}". ${c.note} BUILD it now — create the page(s)/UI and the server actions for it, wired to the database tables planning already created for it (check supabase/migrations and lib/ for the matching table/types). A build that silently drops a promised feature is NOT done.`,
    }));
  return verdictOf("completeness", findings, ranAt);
}

export const completenessGate = { name: "completeness", run: (p: string) => runCompleteness(p) };
