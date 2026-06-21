/**
 * RLS gate — static analysis of Supabase access control. Two complementary checks,
 * both modelled on CVE-2025-48757 (170+ Lovable apps leaked data because a table's
 * REST API was reachable with no Row-Level Security) (PROJECT_BRIEF.md §2, §5):
 *
 *   1. MIGRATION check (`parseRls`): every public table a migration CREATES must
 *      have RLS enabled AND a policy that isn't `using (true)`.
 *   2. COVERAGE check (`parseRlsCoverage`): every table the APP QUERIES (via the
 *      Supabase client `.from('x')`) must be protected by RLS in a migration. An
 *      app that talks to Supabase but ships no RLS for a table it reads is the
 *      literal CVE pattern — and the dangerous default: "no RLS migration found"
 *      is NOT "RLS is fine". So a missing migration FAILS CLOSED (§11, §16/§24),
 *      rather than passing vacuously because there was nothing to parse.
 *
 * Pure (no container, no network): the parsers are functions over text and are
 * fully unit-tested; the only I/O is reading migration + source files off disk.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";
import { DERIVED_DIRS } from "./scan-scope.ts";

/** One migration file's text, tagged with its (relative) path for finding attribution. */
export interface SqlSource {
  file: string;
  sql: string;
}

/** One app source file's text, tagged with its (relative) path. */
export interface CodeSource {
  file: string;
  code: string;
}

/** 1-based line number of a character offset within `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

const DERIVED = new Set<string>(DERIVED_DIRS);
const CODE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte,astro}";
const MAX_CODE_BYTES = 200_000;

// ── Migration facts (shared by both checks) ──────────────────────────────────

/** Tables with `alter table ... enable row level security`, anywhere in the set. */
export function rlsEnabledTables(sources: SqlSource[]): Set<string> {
  const combined = sources.map((s) => s.sql).join("\n").toLowerCase();
  const out = new Set<string>();
  for (const m of combined.matchAll(
    /alter table\s+(?:if exists\s+)?(?:public\.)?(\w+)\s+enable row level security/g,
  )) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

/** Tables whose policy is `using (true)` (authorizes every caller). */
function permissiveTables(sources: SqlSource[]): Set<string> {
  const combined = sources.map((s) => s.sql).join("\n").toLowerCase();
  const out = new Set<string>();
  for (const m of combined.matchAll(
    /create policy[^;]*?\bon\s+(?:public\.)?(\w+)[^;]*?using\s*\(\s*true\s*\)/gs,
  )) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

/** Tables a migration CREATEs (used to avoid double-reporting in the coverage check). */
export function createdTables(sources: SqlSource[]): Set<string> {
  const out = new Set<string>();
  for (const src of sources) {
    for (const m of src.sql.matchAll(/create table\s+(?:if not exists\s+)?(?:public\.)?(\w+)/gi)) {
      if (m[1]) out.add(m[1].toLowerCase());
    }
  }
  return out;
}

// ── Check 1: migration analysis ──────────────────────────────────────────────

/**
 * Pure: migration SQL → Finding[]. A created table with no `enable row level
 * security` → CRITICAL (its REST API is open); a `using (true)` policy → HIGH
 * (authorizes every caller). Each table reported once, attributed to its create.
 */
export function parseRls(sources: SqlSource[]): Finding[] {
  const rlsOn = rlsEnabledTables(sources);
  const permissive = permissiveTables(sources);

  const findings: Finding[] = [];
  const seen = new Set<string>();
  const createRe = /create table\s+(?:if not exists\s+)?(?:public\.)?(\w+)/gi;

  for (const src of sources) {
    for (const m of src.sql.matchAll(createRe)) {
      const table = m[1]?.toLowerCase();
      if (!table || seen.has(table)) continue;
      seen.add(table);
      const line = lineAt(src.sql, m.index ?? 0);
      if (!rlsOn.has(table)) {
        findings.push({
          tool: "rls",
          ruleId: "rls-disabled",
          severity: "critical",
          file: src.file,
          line,
          message: `RLS not enabled on public.${table} — Supabase exposes this table's REST API to the world`,
        });
      } else if (permissive.has(table)) {
        findings.push({
          tool: "rls",
          ruleId: "rls-policy-using-true",
          severity: "high",
          file: src.file,
          line,
          message: `RLS policy \`using (true)\` on public.${table} authorizes every caller — leaks all rows`,
        });
      }
    }
  }
  return findings;
}

// ── Check 2: client-usage coverage (the fail-closed fix) ─────────────────────

/** What the app's source reveals about its Supabase data surface. */
export interface SupabaseUsage {
  /** True if the project depends on / imports @supabase/supabase-js. */
  usesSupabase: boolean;
  /** table name → first `.from('table')` call site, for attribution. */
  tables: Map<string, { file: string; line: number }>;
}

/**
 * Pure: app source (+ whether package.json depends on supabase) → the set of
 * tables the client queries via `.from('x')`. We only trust `.from()` as a table
 * query once Supabase is confirmed (import or dependency), so we don't mistake an
 * unrelated `.from()` (knex, RxJS, Array.from) for a Supabase table.
 */
export function detectSupabaseUsage(sources: CodeSource[], pkgHasSupabase = false): SupabaseUsage {
  let usesSupabase = pkgHasSupabase;
  for (const { code } of sources) {
    if (code.includes("@supabase/supabase-js")) {
      usesSupabase = true;
      break;
    }
  }
  const tables = new Map<string, { file: string; line: number }>();
  if (!usesSupabase) return { usesSupabase, tables };

  const fromRe = /\.from\(\s*['"`]([A-Za-z_]\w*)['"`]\s*\)/g;
  for (const { file, code } of sources) {
    for (const m of code.matchAll(fromRe)) {
      const table = m[1]?.toLowerCase();
      if (table && !tables.has(table)) tables.set(table, { file, line: lineAt(code, m.index ?? 0) });
    }
  }
  return { usesSupabase, tables };
}

/**
 * Pure: every queried table that is NOT protected by RLS in a migration → a
 * CRITICAL `rls-missing` finding. This is the fail-closed half: "no migration" or
 * "migration doesn't cover this table" must BLOCK, not pass. Tables a migration
 * created are skipped here — `parseRls` already adjudicates those (no double-count).
 */
export function parseRlsCoverage(
  usage: SupabaseUsage,
  rlsOn: Set<string>,
  created: Set<string>,
): Finding[] {
  if (!usage.usesSupabase) return [];
  const findings: Finding[] = [];
  for (const [table, at] of [...usage.tables].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (rlsOn.has(table) || created.has(table)) continue;
    findings.push({
      tool: "rls",
      ruleId: "rls-missing",
      severity: "critical",
      file: at.file,
      line: at.line,
      message: `the app queries Supabase table \`${table}\` but no migration enables row level security on it — its REST API is open to the world (CVE-2025-48757: "RLS not found" is not "RLS fine")`,
    });
  }
  return findings;
}

// ── I/O ──────────────────────────────────────────────────────────────────────

/** Read `<projectPath>/supabase/migrations/*.sql` into typed sources. */
export async function readMigrations(projectPath: string): Promise<SqlSource[]> {
  const dir = join(projectPath, "supabase", "migrations");
  // No migrations dir → readMigrations returns []. That alone no longer means
  // "pass": the coverage check decides, using what the app actually queries.
  if (!existsSync(dir)) return [];
  const glob = new Glob("*.sql");
  const sources: SqlSource[] = [];
  for await (const rel of glob.scan({ cwd: dir })) {
    const sql = await Bun.file(join(dir, rel)).text();
    sources.push({ file: join("supabase", "migrations", rel), sql });
  }
  sources.sort((a, b) => a.file.localeCompare(b.file));
  return sources;
}

/** Read the app's authored source (excluding derived dirs) for usage analysis. */
export async function readAppSources(projectPath: string): Promise<CodeSource[]> {
  const glob = new Glob(CODE_GLOB);
  const out: CodeSource[] = [];
  for await (const rel of glob.scan({ cwd: projectPath, dot: false })) {
    if (rel.split("/").some((seg) => DERIVED.has(seg))) continue;
    try {
      const code = await Bun.file(join(projectPath, rel)).text();
      if (code.length <= MAX_CODE_BYTES) out.push({ file: rel, code });
    } catch {
      /* unreadable file → skip */
    }
  }
  return out;
}

/** Does package.json declare a dependency on the Supabase client? */
export function pkgUsesSupabase(projectPath: string): boolean {
  const p = join(projectPath, "package.json");
  if (!existsSync(p)) return false;
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.keys(deps).some((d) => d === "@supabase/supabase-js" || d.startsWith("@supabase/"));
  } catch {
    return false;
  }
}

/** Run the static RLS check (migrations + client-usage coverage) against `projectPath`. */
export async function runRls(
  projectPath: string,
  ranAt: string = new Date().toISOString(),
): Promise<GateVerdict> {
  const sources = await readMigrations(projectPath);
  const appSources = await readAppSources(projectPath);
  const usage = detectSupabaseUsage(appSources, pkgUsesSupabase(projectPath));
  const findings = [
    ...parseRls(sources),
    ...parseRlsCoverage(usage, rlsEnabledTables(sources), createdTables(sources)),
  ];
  return verdictOf("rls", findings, ranAt);
}

export const rlsGate = { name: "rls", run: (p: string) => runRls(p) };
