/**
 * The fixer — the "skill" half of the auto-fix loop (PROJECT_BRIEF.md §11: LLM
 * proposes, deterministic disposes). Two strategies, split on the §11 boundary:
 *  • dependency CVEs → DETERMINISTIC bump (version from the gate finding, not the
 *    model — see depbump.ts);
 *  • everything else (build breaks, code findings) → the LLM, given the findings +
 *    the build error + the current source, emits corrected files as bolt actions
 *    that materialize over the workspace.
 * The gate, not the fixer, decides whether the fix worked (the loop re-gates).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { EngineConfig, Finding, GateVerdict } from "../types.ts";
import { isBlocking } from "../types.ts";
import { BoltEngine } from "../engine/bolt/engine.ts";
import { liveBoltDriver, type ModelFactory } from "../engine/bolt/driver.ts";
import { translateFinding } from "../translate/index.ts";
import { DERIVED_DIRS } from "../gate/scan-scope.ts";
import { applyDepBumps } from "./depbump.ts";

/** Applies fixes for a set of (blocked) verdicts to the workspace, in place. */
export type Fixer = (workspacePath: string, verdicts: GateVerdict[]) => Promise<void>;

export interface DefaultFixerOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
  /** byte cap on source included in the fix prompt (keeps the call bounded). */
  sourceCap?: number;
}

const DERIVED = new Set<string>(DERIVED_DIRS);

/** Read authored source (excluding derived dirs) up to a total byte cap, for context. */
function readAuthoredFiles(root: string, cap: number): Array<{ rel: string; content: string }> {
  const out: Array<{ rel: string; content: string }> = [];
  let total = 0;
  const walk = (dir: string): void => {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (total >= cap) return;
        const abs = join(dir, e.name);
        if (e.isDirectory()) {
          if (!DERIVED.has(e.name)) walk(abs);
        } else if (e.isFile()) {
          let content: string;
          try {
            content = readFileSync(abs, "utf8");
          } catch {
            continue;
          }
          if (content.length > 16_000) continue; // skip oversized/lockfiles
          total += content.length;
          out.push({ rel: relative(root, abs), content });
        }
      }
    } catch {
      /* unreadable dir → skip */
    }
  };
  walk(root);
  return out;
}

function buildFixPrompt(workspacePath: string, findings: Finding[], cap: number): string {
  const lines: string[] = [
    "The app you generated FAILED the deploy gate. Fix ONLY the issues below and make the minimal changes needed to pass. Output the corrected and any new files as bolt file actions (<boltArtifact> with <boltAction type=\"file\" filePath=\"...\">). Do not regenerate unrelated files; do not explain.",
    "",
    "Issues to fix:",
  ];
  for (const f of findings) {
    const e = translateFinding(f);
    lines.push(`- [${f.severity}] ${e.title} — ${f.message} (${f.tool}:${f.ruleId} @ ${f.file}:${f.line ?? "?"})`);
  }
  lines.push("", "Current project files (authored source):");
  for (const { rel, content } of readAuthoredFiles(workspacePath, cap)) {
    lines.push(`\n--- ${rel} ---\n${content}`);
  }
  return lines.join("\n");
}

/** The production fixer: deterministic dep-bumps + an LLM pass for the rest. */
export function defaultFixer(opts: DefaultFixerOptions = {}): Fixer {
  const config: EngineConfig =
    opts.config ??
    (process.env.OPENCODE_API_KEY
      ? { provider: "opencode", model: "deepseek-v4-pro" }
      : { provider: "anthropic", model: "claude-opus-4-8" });
  const cap = opts.sourceCap ?? 60_000;

  return async (workspacePath, verdicts) => {
    const blocking = verdicts.flatMap((v) => v.findings).filter(isBlocking);

    // 1) Dependency CVEs → deterministic bump (version from the finding).
    const depFindings = blocking.filter((f) => f.tool === "trivy" && f.ruleId !== "scan-failed");
    if (depFindings.length) applyDepBumps(workspacePath, depFindings);

    // 2) Everything else → LLM, given findings + build error + current source.
    const codeFindings = blocking.filter((f) => f.tool !== "trivy");
    if (codeFindings.length) {
      const session = await new BoltEngine(liveBoltDriver({ modelFactory: opts.modelFactory })).startSession(
        workspacePath,
        config,
      );
      try {
        for await (const _ of session.prompt(buildFixPrompt(workspacePath, codeFindings, cap))) void _;
      } finally {
        await session.dispose();
      }
    }
  };
}
