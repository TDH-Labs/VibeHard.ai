/**
 * RLS gate — static analysis of Supabase migrations. Every public table must
 * have Row-Level Security enabled AND a policy that isn't `using (true)`. This
 * is the exact check that would have caught CVE-2025-48757 across 170+ Lovable
 * apps (PROJECT_BRIEF.md §2, §5). Ported from ~/dev/gate-proof/gates/rls_check.py.
 *
 * Pure (no container, no network): the parser is a function over SQL text and is
 * fully unit-tested; the only I/O is reading the migration files off disk.
 */
import { join } from "node:path";
import { Glob } from "bun";
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";

/** One migration file's text, tagged with its (relative) path for finding attribution. */
export interface SqlSource {
  file: string;
  sql: string;
}

/** 1-based line number of a character offset within `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * Pure: migration SQL → Finding[]. Faithful to the proof's logic —
 *  - a `create table` with no matching `enable row level security` → CRITICAL
 *    (the table's REST API is open to the world);
 *  - a table whose policy is `using (true)` → HIGH (authorizes every caller).
 * Detection of RLS-enabled / permissive tables is global across all sources
 * (an enable can live in a different migration than the create); each table is
 * reported once, attributed to where it was created. No I/O.
 */
export function parseRls(sources: SqlSource[]): Finding[] {
  const combined = sources.map((s) => s.sql).join("\n").toLowerCase();

  const collect = (re: RegExp): Set<string> => {
    const out = new Set<string>();
    for (const m of combined.matchAll(re)) if (m[1]) out.add(m[1]);
    return out;
  };

  const rlsOn = collect(/alter table\s+(?:if exists\s+)?(?:public\.)?(\w+)\s+enable row level security/g);
  const permissive = collect(/create policy[^;]*?\bon\s+(?:public\.)?(\w+)[^;]*?using\s*\(\s*true\s*\)/gs);

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

/** Read `<projectPath>/supabase/migrations/*.sql` into typed sources. The only I/O. */
export async function readMigrations(projectPath: string): Promise<SqlSource[]> {
  const dir = join(projectPath, "supabase", "migrations");
  const glob = new Glob("*.sql");
  const sources: SqlSource[] = [];
  for await (const rel of glob.scan({ cwd: dir })) {
    const sql = await Bun.file(join(dir, rel)).text();
    sources.push({ file: join("supabase", "migrations", rel), sql });
  }
  sources.sort((a, b) => a.file.localeCompare(b.file));
  return sources;
}

/** Run the static RLS check against `projectPath` and return a verdict. */
export async function runRls(
  projectPath: string,
  ranAt: string = new Date().toISOString(),
): Promise<GateVerdict> {
  const sources = await readMigrations(projectPath);
  return verdictOf("rls", parseRls(sources), ranAt);
}

export const rlsGate = { name: "rls", run: (p: string) => runRls(p) };
