/**
 * Change requests (EPIC #52), stage 4: versioning. Before a change touches anything, the
 * authored source is snapshotted to .vibehard/versions/<n>/ so a bad change (or a change the
 * customer regrets) is one deterministic rollback away — restore the snapshot, re-ship the
 * artifact that already passed its gates. Only authored files are copied (derived output and
 * node_modules are rebuildable); .vibehard itself is excluded except the front-half artifacts,
 * which rollback needs to restore too (a change rewrites spec/prd).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DERIVED_DIRS } from "../gate/scan-scope.ts";

const SKIP = new Set<string>([...DERIVED_DIRS, "node_modules", ".git", ".gate", ".vibehard"]);
/** Front-half artifacts a rollback must restore alongside the source (a change rewrites them). */
const VIBEHARD_ARTIFACTS = ["spec.json", "prd.json", "srs.json", "architecture.json", "datamodel.json"];

const versionsDir = (target: string): string => join(target, ".vibehard", "versions");

export function listVersions(target: string): number[] {
  const dir = versionsDir(target);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
}

/** Copy the authored tree (+ front-half artifacts) to .vibehard/versions/<n>/. Returns n. */
export function snapshotVersion(target: string): number {
  const n = (listVersions(target).at(-1) ?? 0) + 1;
  const dest = join(versionsDir(target), String(n));
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(target)) {
    if (SKIP.has(entry)) continue;
    cpSync(join(target, entry), join(dest, entry), { recursive: true });
  }
  mkdirSync(join(dest, ".vibehard"), { recursive: true });
  for (const f of VIBEHARD_ARTIFACTS) {
    const src = join(target, ".vibehard", f);
    if (existsSync(src)) cpSync(src, join(dest, ".vibehard", f));
  }
  return n;
}

/** Restore snapshot <n> (default: latest): authored files not in the snapshot are deleted,
 *  snapshot files win, derived output is cleared so nothing stale survives the rollback.
 *  Returns the restored version number, or null when there is nothing to restore. */
export function rollbackToVersion(target: string, version?: number): number | null {
  const versions = listVersions(target);
  const n = version ?? versions.at(-1);
  if (!n || !versions.includes(n)) return null;
  const src = join(versionsDir(target), String(n));
  // Delete current authored entries (a change may have ADDED files the snapshot lacks).
  for (const entry of readdirSync(target)) {
    if (SKIP.has(entry)) continue;
    rmSync(join(target, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(src)) {
    if (entry === ".vibehard") continue;
    cpSync(join(src, entry), join(target, entry), { recursive: true });
  }
  for (const f of VIBEHARD_ARTIFACTS) {
    const a = join(src, ".vibehard", f);
    if (existsSync(a)) cpSync(a, join(target, ".vibehard", f));
  }
  // Derived BUILD output was built from the rolled-BACK-from source — clear it (rebuilt on the
  // next verify). Explicit list, NOT DERIVED_DIRS: that constant includes .vibehard and .git,
  // which a rollback must never touch (found by this module's own tests — DERIVED_DIRS deleted
  // the audit trail and the snapshots themselves). node_modules stays; installStale re-syncs it.
  for (const d of [".next", "dist", "build", "out", "coverage", ".turbo"]) {
    const p = join(target, d);
    if (existsSync(p) && statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
  }
  return n;
}
