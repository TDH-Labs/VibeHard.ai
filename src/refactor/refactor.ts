/**
 * refactor-phase (PROJECT_BRIEF.md §22, §17 maintainability tier). Runs AFTER the app
 * passes the gates (production rigor only): improve code QUALITY without changing
 * behavior. The pattern is the project's spine — skill proposes, deterministic
 * disposes — applied to maintainability:
 *
 *   checkpoint the passing tree → score quality (LLM) → refactor behavior-preservingly
 *   (LLM) → RE-VERIFY → accept if green, else REVERT to the checkpoint.
 *
 * THE IRON RULE: a refactor that breaks the gate is reverted, no exceptions — "the
 * passing build is sacred." Bounded to 2 passes. The loop here is pure orchestration
 * (scorer / refactorer / verify / checkpointer are injected, so it's fully testable
 * with fakes); the deterministic re-verify, not the LLM, decides whether a refactor
 * survives.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DERIVED_DIRS } from "../gate/scan-scope.ts";

/** A concrete quality target the scorer found (quality, NOT correctness). */
export interface RefactorTarget {
  file: string;
  issue: string; // e.g. "duplicated validation logic", "120-line function does 3 things"
}
export interface RefactorBrief {
  targets: RefactorTarget[];
  summary: string;
}

/** Score code QUALITY → a brief of concrete targets (LLM proposes). */
export type Scorer = (workspace: string) => Promise<RefactorBrief>;
/** Apply behavior-preserving changes for the brief, in place (LLM codes). */
export type Refactorer = (workspace: string, brief: RefactorBrief) => Promise<void>;
/** Re-verify: did the workspace still pass after the refactor? (deterministic disposer) */
export type Verifier = (workspace: string) => Promise<boolean>;

/** Snapshot/restore the authored source so a bad refactor can be reverted. */
export interface Checkpointer {
  save(workspace: string): string; // returns a backup handle (path)
  restore(workspace: string, backup: string): void;
  cleanup(backup: string): void;
}

export interface RefactorResult {
  passes: number; // refactor attempts made
  accepted: number; // passes whose re-verify stayed green
  rejected: number; // passes reverted because they broke the build
  log: string[];
}

export interface RefactorOptions {
  scorer: Scorer;
  refactorer: Refactorer;
  verify: Verifier;
  checkpoint: Checkpointer;
  budget?: number; // max passes (default 2)
  onStep?: (message: string) => void;
}

export async function refactorPhase(workspace: string, opts: RefactorOptions): Promise<RefactorResult> {
  const budget = Math.max(1, opts.budget ?? 2);
  let backup = opts.checkpoint.save(workspace); // the known-good (passing) tree
  let accepted = 0;
  let rejected = 0;
  let passes = 0;
  const log: string[] = [];

  try {
    for (let pass = 1; pass <= budget; pass++) {
      const brief = await opts.scorer(workspace);
      if (brief.targets.length === 0) {
        log.push(`pass ${pass}: nothing worth refactoring — stopping`);
        break;
      }
      passes++;
      opts.onStep?.(`pass ${pass}: refactoring ${brief.targets.length} target(s) — ${brief.summary}`);
      await opts.refactorer(workspace, brief);

      if (await opts.verify(workspace)) {
        accepted++;
        log.push(`pass ${pass}: accepted — ${brief.summary}`);
        opts.checkpoint.cleanup(backup);
        backup = opts.checkpoint.save(workspace); // the refactored tree is the new known-good
      } else {
        rejected++;
        opts.checkpoint.restore(workspace, backup); // THE IRON RULE: revert; the passing build is sacred
        log.push(`pass ${pass}: REJECTED — the refactor broke the build; reverted to the passing tree`);
        break; // a broken refactor ends the phase — don't gamble further
      }
    }
  } finally {
    opts.checkpoint.cleanup(backup);
  }
  return { passes, accepted, rejected, log };
}

/** Trust boundary: coerce the LLM scorer's JSON into a valid brief. */
export function coerceRefactorBrief(raw: unknown): RefactorBrief {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const targets: RefactorTarget[] = (Array.isArray(o.targets) ? o.targets : [])
    .map((t): RefactorTarget | null => {
      if (!t || typeof t !== "object") return null;
      const to = t as Record<string, unknown>;
      const file = typeof to.file === "string" ? to.file.trim() : "";
      const issue = typeof to.issue === "string" ? to.issue.trim() : "";
      return file || issue ? { file, issue } : null;
    })
    .filter((t): t is RefactorTarget => t !== null);
  return { targets, summary: typeof o.summary === "string" && o.summary.trim() ? o.summary.trim() : `${targets.length} quality target(s)` };
}

// ── the real checkpointer (copy authored source to a temp backup) ─────────────

const EXCLUDE = new Set<string>(DERIVED_DIRS);

export const fileCheckpointer: Checkpointer = {
  save(workspace: string): string {
    const backup = mkdtempSync(join(tmpdir(), "vibehard-refactor-"));
    cpSync(workspace, backup, { recursive: true, filter: (src) => !EXCLUDE.has(src.split("/").pop() ?? "") });
    return backup;
  },
  restore(workspace: string, backup: string): void {
    // copy the known-good files back over the workspace (reverts modifications)
    cpSync(backup, workspace, { recursive: true, force: true });
  },
  cleanup(backup: string): void {
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  },
};
