/**
 * Anti-tamper for the auto-fix loop (audit CRITICAL-1). The fixer hands an unconstrained LLM full write
 * access and counts "files written > 0" as success — so the model can turn a gate GREEN by REMOVING the
 * problem instead of fixing it: delete the flagged migration/table, drop a failing import, etc. A
 * deterministic gate over a shallow signal, optimized against by an LLM, is a gameable objective.
 *
 * This makes the loop refuse a "fix" that shrinks protected surface. We snapshot what must not vanish
 * (security files, database tables, files a SECURITY finding pointed at) before the fix and compare
 * after; a removal is tampering → the round is rejected and the build escalates instead of accepting a
 * gamed pass. Pure functions over the workspace → unit-tested; the loop just calls them.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../types.ts";

export interface ProtectedSurface {
  /** Security-relevant files that exist now (migrations, auth route, middleware, supabase clients). */
  securityFiles: string[];
  /** Table names CREATEd across all migrations. */
  tables: string[];
  /** Files named by current SECURITY findings (deleting one removes the finding without fixing it). */
  flaggedFiles: string[];
}

/** Tools whose findings are security-critical — deleting a file they flagged is tampering, not a fix. */
const SECURITY_TOOLS = new Set(["rls", "rls-enforce", "secrets", "gitleaks", "sast", "semgrep", "migrate"]);
/** Known generated security files; their deletion is never a legitimate auto-fix. */
const KNOWN_SECURITY_FILES = ["middleware.ts", "app/api/auth/signin/route.ts", "lib/supabase/client.ts", "lib/supabase/server.ts", "lib/supabase/admin.ts"];

function migrationFiles(root: string): string[] {
  const dir = join(root, "supabase", "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => join("supabase/migrations", f)).sort();
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

export function captureSurface(root: string, blocking: Finding[]): ProtectedSurface {
  const securityFiles = [...migrationFiles(root), ...KNOWN_SECURITY_FILES.filter((f) => existsSync(join(root, f)))];
  const flaggedFiles = [...new Set(blocking.filter((f) => SECURITY_TOOLS.has(f.tool) && f.file).map((f) => f.file as string))].filter((f) => existsSync(join(root, f)));
  return { securityFiles: [...new Set(securityFiles)].sort(), tables: tablesIn(root), flaggedFiles: flaggedFiles.sort() };
}

/** A fix may not clear a gate by REMOVING protected surface. Returns a human reason if the post-fix
 *  surface dropped a security file, a table, or a security-flagged file the pre-fix surface had; else
 *  null. (Adding surface is always fine — only shrinkage is suspect.) */
export function tamperReason(before: ProtectedSurface, after: ProtectedSurface): string | null {
  const goneFiles = before.securityFiles.filter((f) => !after.securityFiles.includes(f));
  if (goneFiles.length) return `a security file was DELETED (${goneFiles.join(", ")}) instead of fixed`;
  const goneTables = before.tables.filter((t) => !after.tables.includes(t));
  if (goneTables.length) return `a database table was DROPPED (${goneTables.join(", ")}) — shrinking the schema to dodge a finding`;
  const goneFlagged = before.flaggedFiles.filter((f) => !after.flaggedFiles.includes(f));
  if (goneFlagged.length) return `a security-flagged file was DELETED (${goneFlagged.join(", ")}) — the finding was removed, not resolved`;
  return null;
}
