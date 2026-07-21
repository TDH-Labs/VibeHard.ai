/**
 * Generation-reliability eval harness (production-readiness loop, EPIC #38 — the make-or-break).
 *
 * The gate chain answers "is this generated app SAFE to ship?"; this answers the prior, product-level
 * question: "does VibeHard reliably turn a non-technical prompt INTO a shippable app at all?" For each
 * prompt in a corpus it (1) runs the real build pipeline, (2) scores the result through the full gate
 * chain, and (3) aggregates a success rate. That number is the regression signal for the generator.
 *
 * Both expensive steps are INJECTED:
 *   - `build(prompt)` → the workspace dir (default: shell out to `vibehard build`, which costs LLM
 *     tokens + Docker time — so live runs are explicit/opt-in, never implicit in tests).
 *   - `gate(dir)`     → pass/blocking-gates (default: the real runGate).
 * Tests inject fakes (or score existing fixtures) → the harness logic is verified with zero token spend.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../gate/index.ts";
import { llmFunctionalReviewer, type FunctionalCheck } from "../functest/functest.ts";
import { configForStage } from "../config/models.ts";
import { fastPreCheck } from "../gate/fast-checks.ts";

/** One prompt to evaluate. `mustImplement` is feature-coverage the scorer checks (2026-07-09: was
 *  declared in the schema but never actually wired to a scorer — a corpus case could pass purely
 *  by clearing the gates while silently missing what it was asked to build, the exact intent-
 *  fidelity gap the adversarial review exists to catch on the PLAN, not the built app). */
export interface EvalCase {
  id: string;
  prompt: string;
  mustImplement?: string[];
}

export interface EvalCaseResult {
  id: string;
  /** the build pipeline produced a workspace */
  built: boolean;
  /** the produced workspace PASSED the full gate chain AND has no missing mustImplement feature */
  passed: boolean;
  /** which gates blocked (empty when passed) */
  blockingGates: string[];
  /** mustImplement features the functional reviewer found absent — non-empty forces passed=false */
  missingFeatures: string[];
  /** mustImplement features found present-but-incomplete — surfaced, does not block passed */
  partialFeatures: string[];
  /** set when the functional-coverage check itself couldn't run (never blocks the case on its own —
   *  an unrelated reviewer failure isn't evidence the app is missing anything) */
  featureCheckError?: string;
  /** populated when the build itself failed/threw — never crashes the run */
  error?: string;
}

export interface EvalReport {
  results: EvalCaseResult[];
  total: number;
  passed: number;
  /** passed / total in [0,1]; 0 for an empty corpus */
  successRate: number;
}

export interface EvalDeps {
  /** Run the real pipeline for one prompt; return the workspace dir (or null + reason on failure). */
  build: (prompt: string, id: string) => Promise<{ dir: string | null; error?: string }>;
  /** Score a built workspace. Default: the real gate chain. */
  gate?: (dir: string) => Promise<{ passed: boolean; blockingGates: string[] }>;
  /** Check mustImplement feature coverage against the built code. Default: the real functional
   *  reviewer (llmFunctionalReviewer). Only called when a case declares mustImplement. */
  functionalCheck?: FunctionalCheckFn;
}

export type FunctionalCheckFn = (dir: string, mustImplement: string[]) => Promise<FunctionalCheck[]>;

/** Live builder: shells out to the real `vibehard build` per prompt (LLM tokens + Docker), each app in
 *  its own temp dir. Explicit/opt-in only — the unit tests never use this; the CLI gates it behind --live. */
export function cliBuild(cliEntry: string): EvalDeps["build"] {
  return async (prompt, id) => {
    const dir = mkdtempSync(join(tmpdir(), `vibehard-eval-${id}-`));
    const proc = Bun.spawnSync(["bun", cliEntry, "build", prompt, dir], { stdout: "pipe", stderr: "pipe" });
    if ((proc.exitCode ?? 1) !== 0) {
      const log = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`.trim();
      return { dir: null, error: `build exited ${proc.exitCode}${log ? `: ${log.slice(-300)}` : ""}` };
    }
    return { dir };
  };
}

/** Default scorer: the real gate chain. A built app "passes" iff no gate blocks. */
export async function gateScorer(dir: string): Promise<{ passed: boolean; blockingGates: string[] }> {
  const r = await runGate(dir);
  return { passed: r.passed, blockingGates: r.verdicts.filter((v) => v.status === "block").map((v) => v.gate) };
}

/**
 * The regression-harness scorer: fast-checks.ts's deterministic checks run FIRST — seconds, no
 * Docker, no LLM — and only fall through to the real (expensive) gate chain if they pass. A
 * model-spontaneous bug (a stray protocol artifact, a TS error, a migration that doesn't apply to
 * a real Postgres) fails HERE, in seconds, instead of costing a full live cycle to discover.
 * `blockingGates` synthesizes one entry per distinct fast-check kind that fired, so a report line
 * reads the same shape as a real gate-chain failure ("blocked by: fast:stray-marker").
 */
export async function layeredGateScorer(dir: string): Promise<{ passed: boolean; blockingGates: string[] }> {
  const fast = await fastPreCheck(dir);
  if (!fast.passed) {
    return { passed: false, blockingGates: [...new Set(fast.findings.map((f) => `fast:${f.check}`))] };
  }
  return gateScorer(dir);
}

/** Default feature-coverage checker: the real LLM functional reviewer, same one `vibehard functest`
 *  uses. A light/cheap model is plenty — this is a code-reading classification task, not planning. */
export const defaultFunctionalCheck: FunctionalCheckFn = (dir, mustImplement) =>
  llmFunctionalReviewer({ config: configForStage("functest") })(mustImplement, dir);

/** Run every case: build → score → check feature coverage → aggregate. A build failure is a 0 for
 *  that case, never a crash. */
export async function runEval(corpus: EvalCase[], deps: EvalDeps): Promise<EvalReport> {
  const gate = deps.gate ?? gateScorer;
  const functionalCheck = deps.functionalCheck ?? defaultFunctionalCheck;
  const results: EvalCaseResult[] = [];
  for (const c of corpus) {
    try {
      const b = await deps.build(c.prompt, c.id);
      if (!b.dir) {
        results.push({ id: c.id, built: false, passed: false, blockingGates: [], missingFeatures: [], partialFeatures: [], error: b.error ?? "build produced no workspace" });
        continue;
      }
      const g = await gate(b.dir);
      let missingFeatures: string[] = [];
      let partialFeatures: string[] = [];
      let featureCheckError: string | undefined;
      // Only worth checking feature coverage on a build that at least stood up — a gate-blocked
      // app is already a fail, and reading code for features that failed to write is wasted spend.
      if (g.passed && c.mustImplement?.length) {
        try {
          const checks = await functionalCheck(b.dir, c.mustImplement);
          missingFeatures = checks.filter((ck) => ck.status === "missing").map((ck) => ck.feature);
          partialFeatures = checks.filter((ck) => ck.status === "partial").map((ck) => ck.feature);
        } catch (e) {
          // The coverage check's OWN failure is not evidence the app is missing anything — fail
          // open on the CHECK (same discipline as spec-review's adversary and the OpenRouter
          // budget check), surfaced so it's visible rather than silently treated as "all present."
          featureCheckError = e instanceof Error ? e.message : String(e);
        }
      }
      results.push({ id: c.id, built: true, passed: g.passed && missingFeatures.length === 0, blockingGates: g.blockingGates, missingFeatures, partialFeatures, featureCheckError });
    } catch (e) {
      // fail-closed for scoring: a thrown build/gate is a non-pass, recorded — the run always completes.
      results.push({ id: c.id, built: false, passed: false, blockingGates: [], missingFeatures: [], partialFeatures: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  const passed = results.filter((r) => r.passed).length;
  return { results, total: corpus.length, passed, successRate: corpus.length ? passed / corpus.length : 0 };
}

/** Human-readable one-screen summary of a run. */
export function formatReport(report: EvalReport): string {
  const pct = (report.successRate * 100).toFixed(0);
  const lines = [`generation success rate: ${report.passed}/${report.total} (${pct}%)`, ""];
  for (const r of report.results) {
    const mark = r.passed ? "✅" : r.built ? "🛑" : "✗";
    let detail: string;
    if (r.passed) detail = "passed all gates" + (r.partialFeatures.length ? ` (partial: ${r.partialFeatures.join(", ")})` : "");
    else if (r.error) detail = `did not build — ${r.error}`;
    else if (r.missingFeatures.length) detail = `passed the gates but missing: ${r.missingFeatures.join(", ")}`;
    else detail = `blocked by: ${r.blockingGates.join(", ") || "(unknown)"}`;
    lines.push(`  ${mark} ${r.id} — ${detail}`);
    if (r.featureCheckError) lines.push(`     (feature-coverage check itself failed: ${r.featureCheckError} — not counted against the app)`);
  }
  return lines.join("\n");
}
