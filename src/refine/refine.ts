/**
 * iterate / refine loop (backlog #2, docs/specs/iterate-refine.md). After an app is built,
 * the user asks for a plain-language change ("add a logout button"); we regenerate the app
 * INCREMENTALLY (the engine sees the current tree + the change, and emits only the files that
 * change) and re-gate.
 *
 * THE SAFETY INVARIANT (mirrors refactor's iron rule — the passing build is sacred): if the
 * gate passed BEFORE the refine and cannot be made to pass after (even with auto-fix), we
 * restore the original tree and reject the refine. A green build is never silently left red.
 *
 * Spec is the source of truth: an ACCEPTED refine is recorded onto spec.refinements, so the
 * spec keeps describing what the app actually became. A rejected refine records nothing.
 *
 * The orchestrator is pure control flow — the engine pass (`regen`), the gate, the auto-fix,
 * and the checkpointer are injected, so the whole loop (including the restore path) is
 * unit-tested with fakes and no live LLM.
 */
import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Refinement, type Spec } from "../spec/spec.ts";
import { DERIVED_DIRS } from "../gate/scan-scope.ts";
import { fileCheckpointer, type Checkpointer } from "../refactor/refactor.ts";
import { runGate, type PipelineResult } from "../gate/index.ts";
import { autoFix, type AutoFixResult } from "../autofix/autofix.ts";

const DERIVED = new Set<string>(DERIVED_DIRS);

/** Pure: append a change to the spec's refinement trail (additive — never drops features). */
export function appendRefinement(spec: Spec, change: string, at: string): Spec {
  const trail: Refinement[] = Array.isArray(spec.refinements) ? spec.refinements : [];
  return { ...spec, refinements: [...trail, { at, change: change.trim() }] };
}

/** Relative paths of authored source under `dir` (excludes derived/meta dirs, sorted). */
export function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!DERIVED.has(e.name)) walk(join(d, e.name));
      } else if (e.isFile()) {
        out.push(relative(dir, join(d, e.name)));
      }
    }
  };
  try {
    walk(dir);
  } catch {
    /* unreadable → empty */
  }
  return out.sort();
}

const FILE_CAP = 60_000; // per-file include budget (chars)
const TOTAL_CAP = 240_000; // total include budget across all files (chars)

/** Pure: the incremental-refine engine prompt — the current app + the change, with a hard
 *  instruction to touch as few files as possible (minimal blast radius). */
export function buildRefineBrief(change: string, files: { path: string; content: string }[], spec: Spec): string {
  let total = 0;
  const blocks: string[] = [];
  for (const f of files) {
    const body = f.content.length > FILE_CAP ? `${f.content.slice(0, FILE_CAP)}\n… (truncated)` : f.content;
    if (total + body.length > TOTAL_CAP) {
      blocks.push(`\n--- ${f.path} (omitted — context budget) ---`);
      continue;
    }
    total += body.length;
    blocks.push(`\n--- ${f.path} ---\n${body}`);
  }
  return [
    `You are modifying an EXISTING web app called "${spec.name}". Apply ONLY the change requested below.`,
    `Touch as FEW files as possible. Re-emit a file ONLY if it genuinely changes. Do NOT rewrite, reformat, or "improve" unrelated files — leave everything else exactly as it is.`,
    ``,
    `CHANGE REQUESTED:`,
    change.trim(),
    ``,
    `App summary: ${spec.summary}`,
    `Current files:`,
    ...blocks,
    ``,
    `Any file shown as "(omitted — context budget)" still EXISTS unchanged — never recreate, blank, or delete it.`,
    `Emit (in the file protocol) only the files you create or modify to make this change.`,
  ].join("\n");
}

/** Run the engine over the refine brief, in place. Returns whether it succeeded + the files
 *  it wrote. Injected by the caller (the CLI wires the live bolt engine). */
export type RefineRegen = (dir: string, prompt: string) => Promise<{ ok: boolean; filesWritten: string[] }>;
export type RefineGate = (dir: string) => Promise<PipelineResult>;
export type RefineFix = (dir: string) => Promise<AutoFixResult>;

export interface RefineOptions {
  regen: RefineRegen;
  gate?: RefineGate; // default: runGate
  fix?: RefineFix; // default: autoFix
  checkpoint?: Checkpointer; // default: fileCheckpointer
  now: string; // timestamp for the refinement record (caller supplies)
  onStep?: (message: string) => void;
}

export interface RefineResult {
  accepted: boolean; // the refine was kept
  restored: boolean; // true iff a green→red refine was reverted
  wasGreen: boolean; // gate state before the refine
  filesWritten: string[]; // files the engine emitted
  gate: PipelineResult; // final gate state (after accept, or after restore)
  fix: AutoFixResult | null; // auto-fix attempt, if the refine left the gate blocked
  log: string[];
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function tryUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* best-effort */
  }
}
function tryRmdir(p: string): void {
  try {
    rmdirSync(p); // only succeeds when empty — a no-op on non-empty / pre-existing dirs
  } catch {
    /* best-effort */
  }
}

/** Restore the pre-refine tree exactly. The checkpoint reverts modified/deleted source, but can't
 *  undo three things, so we do them here: (a) authored files the refine ADDED (copy-back leaves
 *  them), (b) engine writes into derived/meta dirs (DERIVED is excluded from the backup AND from
 *  listSourceFiles), and (c) now-empty dirs the refine created. Together these make `restored`
 *  byte-for-byte truthful so a green→red revert never silently leaves a changed tree. */
function restoreTree(dir: string, backup: string, preFiles: Set<string>, written: string[], checkpoint: Checkpointer): void {
  checkpoint.restore(dir, backup);
  const removed: string[] = [];
  for (const p of listSourceFiles(dir)) {
    if (!preFiles.has(p)) {
      tryUnlink(join(dir, p));
      removed.push(p);
    }
  }
  for (const raw of written) {
    const rel = raw.replace(/^\/+/, ""); // engine paths can carry a leading slash; normalize
    if (DERIVED.has(rel.split("/")[0] ?? "")) {
      tryUnlink(join(dir, rel));
      removed.push(rel);
    }
  }
  // prune dirs the refine created and just emptied — deepest first so parents become empty in turn.
  const ancestors = new Set<string>();
  for (const p of removed) {
    const parts = p.split("/");
    for (let i = parts.length - 1; i >= 1; i--) ancestors.add(parts.slice(0, i).join("/"));
  }
  for (const a of [...ancestors].sort((x, y) => y.length - x.length)) tryRmdir(join(dir, a));
}

export async function refine(dir: string, change: string, opts: RefineOptions): Promise<RefineResult> {
  const gate = opts.gate ?? ((d: string) => runGate(d));
  const fix = opts.fix ?? ((d: string) => autoFix(d));
  const checkpoint = opts.checkpoint ?? fileCheckpointer;
  const log: string[] = [];
  const note = (m: string): void => {
    log.push(m);
    opts.onStep?.(m);
  };

  const specPath = join(dir, ".drydock", "spec.json");
  if (!existsSync(specPath)) {
    throw new Error(`no .drydock/spec.json in ${dir} — run \`drydock build\` first so there's a spec to refine`);
  }
  const trimmed = change.trim();
  if (!trimmed) throw new Error("refine: the change description is empty");
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec;

  note("checking the current build before refining…");
  const wasGreen = (await gate(dir)).passed;
  const preFiles = new Set(listSourceFiles(dir));
  const backup = checkpoint.save(dir);
  let written: string[] = []; // hoisted so the catch can clean up engine writes even on a throw

  try {
    const files = [...preFiles].map((p) => ({ path: p, content: safeRead(join(dir, p)) }));
    const brief = buildRefineBrief(trimmed, files, spec);
    note(`regenerating with the change (was ${wasGreen ? "green" : "not green"})…`);
    const r = await opts.regen(dir, brief);
    written = r.filesWritten;

    if (!r.ok) {
      // Engine failed mid-regen. If we had a good build, restore it; never leave it half-rewritten.
      if (wasGreen) {
        note("the engine errored during refine — reverting to the previous build");
        restoreTree(dir, backup, preFiles, written, checkpoint);
        const finalGate = await gate(dir);
        return { accepted: false, restored: true, wasGreen, filesWritten: written, gate: finalGate, fix: null, log };
      }
      return { accepted: false, restored: false, wasGreen, filesWritten: written, gate: await gate(dir), fix: null, log };
    }

    let gateResult = await gate(dir);
    let fixResult: AutoFixResult | null = null;
    if (!gateResult.passed) {
      note("refine left the gate blocked — attempting auto-fix…");
      fixResult = await fix(dir);
      gateResult = { verdicts: fixResult.finalVerdicts, passed: fixResult.fixed };
    }

    // Safety invariant: a previously-green build that we can't keep green is reverted.
    if (!gateResult.passed && wasGreen) {
      note("could not keep the gate green — reverting the refine (the passing build is sacred)");
      restoreTree(dir, backup, preFiles, written, checkpoint);
      const finalGate = await gate(dir);
      return { accepted: false, restored: true, wasGreen, filesWritten: written, gate: finalGate, fix: fixResult, log };
    }

    // Accepted — record the change on the spec (shipped reality). Persist only now, so a
    // rejected refine never leaves a phantom refinement behind.
    writeFileSync(specPath, JSON.stringify(appendRefinement(spec, trimmed, opts.now), null, 2));
    note(`refine accepted — ${written.length} file(s) changed; gate ${gateResult.passed ? "green" : "not green (was already not green)"}`);
    return { accepted: true, restored: false, wasGreen, filesWritten: written, gate: gateResult, fix: fixResult, log };
  } catch (e) {
    // The gate/auto-fix/engine threw (subprocess crash, network error). On a previously-green build
    // the safety invariant still holds: revert before propagating, so a crash never leaves it red.
    if (wasGreen) {
      note("an error occurred during refine — reverting to the previous build");
      restoreTree(dir, backup, preFiles, written, checkpoint);
    }
    throw e;
  } finally {
    checkpoint.cleanup(backup);
  }
}
