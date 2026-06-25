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
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";
import { llmFunctionalReviewer, type FunctionalReviewer } from "../functest/functest.ts";

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

  // Only an entirely-MISSING feature blocks. The message is a build order, not a critique — so the
  // fixer's next pass generates it against the tables planning already modeled.
  const findings: Finding[] = checks
    .filter((c) => c.status === "missing")
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
