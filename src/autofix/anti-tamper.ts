/**
 * Anti-tamper for the auto-fix loop (audit CRITICAL-1, hardened in audit2 B-1). The fixer hands an
 * unconstrained LLM full write access and counts "files written > 0" as success — so the model can turn
 * a gate GREEN by REMOVING the problem instead of fixing it. A deterministic gate over a shallow signal,
 * optimized against by an LLM, is a gameable objective.
 *
 * This makes the loop refuse a "fix" that shrinks protected surface. We snapshot what must not vanish
 * (security files, tables, the gate's own input files, RLS enablement/policy counts, security-flagged
 * file bodies, the count of suppression directives) before the fix and compare after; any shrinkage —
 * or a newly-added suppression — is tampering → the round is rejected and the build escalates instead
 * of accepting a gamed pass. Pure functions over the workspace → unit-tested; the loop just calls them.
 *
 * The audit2 walk-arounds this closes (each one returned `fixed:true` against the old surface model):
 *   • delete `.vibehard/datamodel.json` → rls-enforce reports `n/a` → ships a PROVEN cross-tenant leak;
 *   • drop the `.from("secrets")` query so a `rls-missing` finding vanishes (table/file kept);
 *   • gut a flagged file to `export {}` so a sast/secret finding vanishes (file kept);
 *   • remove/disable an RLS policy or `enable row level security` in place;
 *   • silence a check by adding `@ts-ignore` / `eslint-disable` / `nosemgrep` / `as any`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../types.ts";

export interface ProtectedSurface {
  /** Security-relevant files that exist now (migrations, auth route, middleware, supabase clients). */
  securityFiles: string[];
  /** Table names CREATEd across all migrations. */
  tables: string[];
  /** Files named by current SECURITY findings (deleting one removes the finding without fixing it). */
  flaggedFiles: string[];
  /** Gate INPUT files whose deletion silently turns a security gate into a no-op (`n/a`). */
  protectedInputs: string[];
  /** Count of `enable row level security` across migrations — a drop = RLS disabled to dodge a finding. */
  rlsEnableCount: number;
  /** Count of `create policy` across migrations — a drop = a policy removed in place. */
  policyCount: number;
  /** Distinct `.from("x")` table references in app source — a drop = a query removed to hide a finding. */
  tableRefs: string[];
  /** Meaningful (whitespace-stripped) byte length of each security-flagged file — a collapse = gutted. */
  flaggedSizes: Record<string, number>;
  /** Count of suppression directives in source — an increase = a check silenced rather than fixed. */
  suppressions: number;
}

/** Tools whose findings are security-critical — deleting a file they flagged is tampering, not a fix. */
const SECURITY_TOOLS = new Set(["rls", "rls-enforce", "secrets", "gitleaks", "sast", "semgrep", "migrate"]);
/** Known generated security files; their deletion is never a legitimate auto-fix. */
const KNOWN_SECURITY_FILES = ["middleware.ts", "app/api/auth/signin/route.ts", "lib/supabase/client.ts", "lib/supabase/server.ts", "lib/supabase/admin.ts"];
/** Gate inputs the front-half persisted; deleting them makes the data-layer gates report `n/a` (no-op). */
const PROTECTED_INPUTS = [".vibehard/datamodel.json", ".vibehard/spec.json"];

const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".git", ".vibehard", ".vercel", "out", "coverage", ".turbo"]);
/** Suppression directives that silence a static check rather than resolve it. */
const SUPPRESSION_RE = /@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|nosemgrep|\bas\s+any\b/g;
/** `.from("table")` / `.from('table')` data access in Supabase/SQL client code. */
const FROM_RE = /\.from\(\s*['"`]([A-Za-z_][\w]*)['"`]/g;
/** A flagged file is "gutted" if its meaningful body collapses below this fraction of its prior size … */
const GUT_FRACTION = 0.4;
/** … but only when it had real content to begin with (avoids noise on already-tiny files). */
const GUT_FLOOR = 30;

function migrationFiles(root: string): string[] {
  const dir = join(root, "supabase", "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => join("supabase/migrations", f)).sort();
}

/** Concatenate every migration's SQL (lowercased) for counting RLS constructs. */
function migrationSql(root: string): string {
  let sql = "";
  for (const rel of migrationFiles(root)) {
    try {
      sql += readFileSync(join(root, rel), "utf8").toLowerCase() + "\n";
    } catch {
      /* unreadable → skip */
    }
  }
  return sql;
}

function tablesIn(root: string): string[] {
  const tables = new Set<string>();
  for (const rel of migrationFiles(root)) {
    try {
      for (const m of readFileSync(join(root, rel), "utf8").matchAll(/create table\s+(?:if not exists\s+)?(?:"?public"?\s*\.\s*)?"?(\w+)"?/gi)) if (m[1]) tables.add(m[1].toLowerCase());
    } catch {
      /* unreadable → skip */
    }
  }
  return [...tables].sort();
}

function countMatches(haystack: string, re: RegExp): number {
  return (haystack.match(re) ?? []).length;
}

/** Walk app source (skipping derived/dep dirs); cheap, bounded by the tree the fixer can touch. */
function walkSource(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".vibehard") {
        // hidden dirs/files are skipped EXCEPT we never recurse .vibehard (handled as protectedInputs)
        if (e.isDirectory()) continue;
      }
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(full);
      } else if (SOURCE_EXT.some((x) => e.name.endsWith(x))) {
        out.push(full);
      }
    }
  };
  visit(root);
  return out;
}

/** Distinct `.from("x")` table references + total suppression-directive count across app source. */
function scanSource(root: string): { tableRefs: string[]; suppressions: number } {
  const refs = new Set<string>();
  let suppressions = 0;
  for (const file of walkSource(root)) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of content.matchAll(FROM_RE)) if (m[1]) refs.add(m[1].toLowerCase());
    suppressions += countMatches(content, SUPPRESSION_RE);
  }
  return { tableRefs: [...refs].sort(), suppressions };
}

/** Meaningful (whitespace-stripped) length of a workspace-relative file; 0 if absent/unreadable. */
function meaningfulSize(root: string, rel: string): number {
  try {
    const p = join(root, rel);
    if (!statSync(p).isFile()) return 0;
    return readFileSync(p, "utf8").replace(/\s+/g, "").length;
  } catch {
    return 0;
  }
}

export function captureSurface(root: string, blocking: Finding[]): ProtectedSurface {
  const securityFiles = [...migrationFiles(root), ...KNOWN_SECURITY_FILES.filter((f) => existsSync(join(root, f)))];
  const flaggedFiles = [...new Set(blocking.filter((f) => SECURITY_TOOLS.has(f.tool) && f.file).map((f) => f.file as string))].filter((f) => existsSync(join(root, f)));
  const sql = migrationSql(root);
  const { tableRefs, suppressions } = scanSource(root);
  const flaggedSizes: Record<string, number> = {};
  for (const f of flaggedFiles) flaggedSizes[f] = meaningfulSize(root, f);
  return {
    securityFiles: [...new Set(securityFiles)].sort(),
    tables: tablesIn(root),
    flaggedFiles: flaggedFiles.sort(),
    protectedInputs: PROTECTED_INPUTS.filter((f) => existsSync(join(root, f))).sort(),
    rlsEnableCount: countMatches(sql, /enable row level security/g),
    policyCount: countMatches(sql, /create policy/g),
    tableRefs,
    flaggedSizes,
    suppressions,
  };
}

/** A fix may not clear a gate by REMOVING or SILENCING protected surface. Returns a human reason if the
 *  post-fix surface shrank (a security file/table/flagged file/gate input/RLS construct/query gone, a
 *  flagged file gutted) or a suppression was added; else null. (Adding surface is always fine.) */
export function tamperReason(before: ProtectedSurface, after: ProtectedSurface): string | null {
  const goneFiles = before.securityFiles.filter((f) => !after.securityFiles.includes(f));
  if (goneFiles.length) return `a security file was DELETED (${goneFiles.join(", ")}) instead of fixed`;

  const goneTables = before.tables.filter((t) => !after.tables.includes(t));
  if (goneTables.length) return `a database table was DROPPED (${goneTables.join(", ")}) — shrinking the schema to dodge a finding`;

  const goneFlagged = before.flaggedFiles.filter((f) => !after.flaggedFiles.includes(f));
  if (goneFlagged.length) return `a security-flagged file was DELETED (${goneFlagged.join(", ")}) — the finding was removed, not resolved`;

  // audit2 B-1: deleting a gate's input file silently turns a security gate into a no-op (`n/a`) → green.
  const goneInputs = before.protectedInputs.filter((f) => !after.protectedInputs.includes(f));
  if (goneInputs.length) return `a gate INPUT was DELETED (${goneInputs.join(", ")}) — removing it makes the data-layer gates report n/a, shipping an unverified schema`;

  // audit2 B-1: RLS disabled / a policy removed in place (file kept, construct gutted).
  if (after.rlsEnableCount < before.rlsEnableCount) return `RLS was DISABLED — 'enable row level security' count dropped ${before.rlsEnableCount}→${after.rlsEnableCount} (weakening isolation to clear a finding)`;
  if (after.policyCount < before.policyCount) return `an RLS policy was REMOVED — 'create policy' count dropped ${before.policyCount}→${after.policyCount}`;

  // audit2 B-1: a data access removed so its finding vanishes (table/file kept, query deleted).
  const goneRefs = before.tableRefs.filter((t) => !after.tableRefs.includes(t));
  if (goneRefs.length) return `a data access was REMOVED (.from('${goneRefs.join("'), .from('")}')) — dropping the query hides the finding instead of securing the table`;

  // audit2 B-1: a flagged file gutted (e.g. overwritten with `export {}`) so its finding vanishes.
  for (const f of before.flaggedFiles) {
    if (!(f in after.flaggedSizes)) continue; // deletion is already covered above
    const b = before.flaggedSizes[f] ?? 0;
    const a = after.flaggedSizes[f] ?? 0;
    if (b >= GUT_FLOOR && a < b * GUT_FRACTION) return `a security-flagged file was GUTTED (${f}: ${b}→${a} meaningful chars) — emptied to clear the finding, not fixed`;
  }

  // audit2 B-1: a check silenced via a suppression directive rather than resolved.
  if (after.suppressions > before.suppressions) return `a suppression directive was ADDED (@ts-ignore / eslint-disable / nosemgrep / 'as any' count ${before.suppressions}→${after.suppressions}) — silencing a check instead of fixing it`;

  return null;
}
