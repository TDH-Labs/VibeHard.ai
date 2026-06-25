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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { VIBEHARD_SYSTEM_PROMPT, PYTHON_SYSTEM_PROMPT } from "../engine/bolt/prompt.ts";
import type { EngineConfig, Finding, GateVerdict } from "../types.ts";
import { isBlocking } from "../types.ts";
import { configForStage } from "../config/models.ts";
import { BoltEngine } from "../engine/bolt/engine.ts";
import { liveBoltDriver, type ModelFactory } from "../engine/bolt/driver.ts";
import { translateFinding } from "../translate/index.ts";
import { DERIVED_DIRS } from "../gate/scan-scope.ts";
import { applyDepBumps, type DepBumpResult } from "./depbump.ts";
import { applyMissingDeps, parseMissingModules } from "./missingdeps.ts";
import { detectUndeclaredImports } from "../diagnose/diagnose.ts";
import { parseBuildErrors } from "../gate/build-errors.ts";
import { readJournal } from "../journal/journal.ts";

/** Run `tsc --noEmit` to surface EVERY type error at once (the BATCHED view). `next build`
 *  stops at the first error, so a big app's tail is discovered one-per-rebuild and exhausts
 *  the attempt budget; this lets the fixer address them all in a single pass. */
function collectTypeErrors(workspacePath: string): Finding[] {
  if (!existsSync(join(workspacePath, "tsconfig.json"))) return [];
  const r = Bun.spawnSync(["npx", "tsc", "--noEmit"], { cwd: workspacePath, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  if ((r.exitCode ?? 0) === 0) return [];
  return parseBuildErrors(`${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`, workspacePath);
}

/** Applies fixes for a set of (blocked) verdicts to the workspace, in place. */
export type Fixer = (workspacePath: string, verdicts: GateVerdict[]) => Promise<void>;

export interface DefaultFixerOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
  /** byte cap on source included in the fix prompt (keeps the call bounded). */
  sourceCap?: number;
}

const DERIVED = new Set<string>(DERIVED_DIRS);

/** List authored source files (excluding derived dirs), skipping only the truly
 *  oversized (lockfiles, generated bundles). No total cap here — the caller orders
 *  by relevance and applies the budget, so a relevant file is never dropped merely
 *  for sorting after an irrelevant one. */
function listAuthoredFiles(root: string): Array<{ rel: string; content: string }> {
  const out: Array<{ rel: string; content: string }> = [];
  const walk = (dir: string): void => {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
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
          if (content.length > 40_000) continue; // skip lockfiles / generated bundles
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

/** Pull the files + symbols the findings point at, so the fixer SEES what it must
 *  change. A build error like "'supabaseAdmin' is not exported from '…/admin'" needs
 *  the module AND every importer in the prompt together — reconciling a cross-file
 *  mismatch is impossible when half of it is outside the window. */
export function findingTargets(root: string, findings: Finding[]): { files: Set<string>; symbols: string[] } {
  const files = new Set<string>();
  const symbols = new Set<string>();
  for (const f of findings) {
    if (f.file && f.file !== "package.json" && f.file !== "Dockerfile" && existsSync(join(root, f.file))) files.add(f.file);
    for (const m of (f.message ?? "").matchAll(/'([A-Za-z_$][A-Za-z0-9_$]{1,})'/g)) {
      const s = m[1]!;
      if (!s.includes("/") && !s.includes(".") && !s.includes("@")) symbols.add(s); // an identifier, not a path/module
    }
  }
  return { files, symbols: [...symbols] };
}

/** Order authored files relevance-first (finding-named files + files mentioning a
 *  broken symbol, then the rest) and include them under the byte budget. Priority
 *  files lead, so the files the fix actually touches are never truncated away. */
export function readFixSources(root: string, findings: Finding[], cap: number): Array<{ rel: string; content: string }> {
  const all = listAuthoredFiles(root);
  const { files, symbols } = findingTargets(root, findings);
  const symbolRe = symbols.length ? new RegExp(`\\b(?:${symbols.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`) : null;
  const isPriority = (f: { rel: string; content: string }): boolean => files.has(f.rel) || (symbolRe ? symbolRe.test(f.content) : false);

  const ordered = [...all.filter(isPriority), ...all.filter((f) => !isPriority(f))];
  const out: Array<{ rel: string; content: string }> = [];
  let total = 0;
  for (const f of ordered) {
    if (total >= cap) break;
    total += f.content.length;
    out.push(f);
  }
  return out;
}

function buildFixPrompt(workspacePath: string, findings: Finding[], majorBumped: DepBumpResult["majorBumped"], cap: number): string {
  const lines: string[] = [
    "The app you generated FAILED the deploy gate. Make the MINIMAL changes needed to pass. Output the corrected and any new files as bolt file actions (<boltArtifact> with <boltAction type=\"file\" filePath=\"...\">). Do not regenerate unrelated files; do not explain.",
    "",
  ];
  if (majorBumped.length) {
    lines.push(
      "These dependencies were just upgraded across a MAJOR version (already changed in package.json) to patch security vulnerabilities. Adapt the code to each new major's BREAKING changes — renamed/removed/relocated APIs, changed imports, newly-async APIs, config and peer-dependency changes. Keep all behavior and security (auth, RLS, ownership scoping) IDENTICAL:",
    );
    for (const m of majorBumped) lines.push(`- ${m.pkg}: ${m.from} → ${m.to}`);
    lines.push("");
  }
  if (findings.length) {
    lines.push("Issues to fix:");
    for (const f of findings) {
      const e = translateFinding(f);
      lines.push(`- [${f.severity}] ${e.title} — ${f.message} (${f.tool}:${f.ruleId} @ ${f.file}:${f.line ?? "?"})`);
    }
    lines.push("");
  }
  // The as-built journal of PRIOR rounds — so you don't repeat a fix that already failed.
  // If a finding recurs here, your last attempt didn't work: change APPROACH, don't retry it.
  const journal = readJournal(workspacePath);
  if (journal.trim()) {
    lines.push("Prior attempts this build (from the as-built journal — do NOT repeat a fix that already failed; if an issue recurs, try a different approach):");
    lines.push(journal, "");
  }
  lines.push("Current project files (authored source — the files the issues point at come first):");
  for (const { rel, content } of readFixSources(workspacePath, findings, cap)) {
    lines.push(`\n--- ${rel} ---\n${content}`);
  }
  return lines.join("\n");
}

/** The production fixer: deterministic dep-bumps + an LLM pass for the rest. */
export function defaultFixer(opts: DefaultFixerOptions = {}): Fixer {
  const config: EngineConfig = opts.config ?? configForStage("fix"); // strong CODE model — fixing is code-critical
  const cap = opts.sourceCap ?? 120_000; // priority-ordered: targets lead, so this fits a mid-size app's relevant files

  return async (workspacePath, verdicts) => {
    const blocking = verdicts.flatMap((v) => v.findings).filter(isBlocking);

    // 1) Dependency CVEs → deterministic version bump (same-major where possible; a
    //    breaking MAJOR bump as the fallback — the version still comes from the finding, §11).
    const depFindings = blocking.filter((f) => f.tool === "trivy" && f.ruleId !== "scan-failed");
    const depResult = depFindings.length ? applyDepBumps(workspacePath, depFindings) : null;
    const majorBumped = depResult?.majorBumped ?? [];

    // 2) Imported-but-UNDECLARED packages → deterministic `npm install` (version from the
    //    registry, §11; also re-syncs the lockfile). The build only names ONE missing module
    //    per failure, so a build with several undeclared deps would need one rebuild PER dep
    //    and exhaust the attempt budget. So when the build is failing, install the named one
    //    AND every statically-undeclared import in ONE pass — closing the whole class at once.
    const verifyFailing = blocking.some((f) => f.tool === "verify");
    const missing = [...new Set([...parseMissingModules(blocking), ...(verifyFailing ? detectUndeclaredImports(workspacePath) : [])])];
    const missingResult = missing.length ? applyMissingDeps(workspacePath, missing) : null;
    const installedMissing = (missingResult?.installed.length ?? 0) > 0;

    // 3) The LLM pass — for code findings AND to adapt the code to any breaking major
    //    upgrade just applied. The gate (next re-gate) verifies whatever it produces (§11).
    //    When we just deterministically installed a missing module, leave THIS round's
    //    verify (build/clean-verify) findings to the re-gate — don't let the LLM rewrite
    //    package.json in parallel and undo the deterministic install (the observed regression).
    // Batched type errors: when the build is failing (and we're not deferring to a re-gate
    // after a deterministic dep install), enumerate ALL type errors with tsc and hand the
    // whole set to the LLM at once — so it fixes the tail in one pass, not one-per-rebuild.
    const tscFindings = verifyFailing && !installedMissing ? collectTypeErrors(workspacePath) : [];
    const codeFindings = [...blocking.filter((f) => f.tool !== "trivy" && !(installedMissing && f.tool === "verify")), ...tscFindings];
    if (codeFindings.length || majorBumped.length) {
      // Fix in the app's OWN language — a Python workspace (requirements.txt/pyproject)
      // gets the Python prompt, so the fixer's edits match the stack it's repairing.
      const usesPython = existsSync(join(workspacePath, "requirements.txt")) || existsSync(join(workspacePath, "pyproject.toml"));
      const systemPrompt = usesPython ? PYTHON_SYSTEM_PROMPT : VIBEHARD_SYSTEM_PROMPT;
      const session = await new BoltEngine(liveBoltDriver({ modelFactory: opts.modelFactory, systemPrompt })).startSession(
        workspacePath,
        config,
      );
      let filesWritten = 0;
      let streamError = "";
      try {
        for await (const ev of session.prompt(buildFixPrompt(workspacePath, codeFindings, majorBumped, cap))) {
          if (ev.type === "file-changed") filesWritten++;
          else if (ev.type === "error") streamError = ev.message;
        }
      } finally {
        await session.dispose();
      }
      // A fix pass that materialized ZERO files did nothing — and silently "succeeding" lets the
      // loop burn the whole attempt budget re-gating an unchanged workspace (observed: a 7-feature
      // ask returned no bolt actions, plateauing after a 12-min no-op). Surface it so the loop
      // escalates with a real reason instead of mistaking emptiness for a completed attempt. The
      // actionable signal: the ask was likely too large for one pass — fix fewer findings per round.
      if (!filesWritten) {
        throw new Error(`the fix model produced no file changes for ${codeFindings.length} finding(s)${streamError ? ` (engine error: ${streamError})` : ""} — the ask may be too large for one pass; reduce the findings addressed per attempt`);
      }
    }
  };
}
