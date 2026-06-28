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
import { runGate } from "../gate/index.ts";

/** One prompt to evaluate. `mustImplement` is optional feature-coverage the scorer can later check. */
export interface EvalCase {
  id: string;
  prompt: string;
  mustImplement?: string[];
}

export interface EvalCaseResult {
  id: string;
  /** the build pipeline produced a workspace */
  built: boolean;
  /** the produced workspace PASSED the full gate chain (safe + working) */
  passed: boolean;
  /** which gates blocked (empty when passed) */
  blockingGates: string[];
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
}

/** Default scorer: the real gate chain. A built app "passes" iff no gate blocks. */
export async function gateScorer(dir: string): Promise<{ passed: boolean; blockingGates: string[] }> {
  const r = await runGate(dir);
  return { passed: r.passed, blockingGates: r.verdicts.filter((v) => v.status === "block").map((v) => v.gate) };
}

/** Run every case: build → score → aggregate. A build failure is a 0 for that case, never a crash. */
export async function runEval(corpus: EvalCase[], deps: EvalDeps): Promise<EvalReport> {
  const gate = deps.gate ?? gateScorer;
  const results: EvalCaseResult[] = [];
  for (const c of corpus) {
    try {
      const b = await deps.build(c.prompt, c.id);
      if (!b.dir) {
        results.push({ id: c.id, built: false, passed: false, blockingGates: [], error: b.error ?? "build produced no workspace" });
        continue;
      }
      const g = await gate(b.dir);
      results.push({ id: c.id, built: true, passed: g.passed, blockingGates: g.blockingGates });
    } catch (e) {
      // fail-closed for scoring: a thrown build/gate is a non-pass, recorded — the run always completes.
      results.push({ id: c.id, built: false, passed: false, blockingGates: [], error: e instanceof Error ? e.message : String(e) });
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
    const detail = r.passed ? "passed all gates" : r.error ? `did not build — ${r.error}` : `blocked by: ${r.blockingGates.join(", ") || "(unknown)"}`;
    lines.push(`  ${mark} ${r.id} — ${detail}`);
  }
  return lines.join("\n");
}
