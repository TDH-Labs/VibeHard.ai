/**
 * Fast, deterministic pre-checks — catch model-spontaneous bugs in SECONDS, before the real gate
 * chain ever runs (Docker builds, live sandbox boots, a real deploy — the thing that makes a
 * 45-minute live E2B cycle cost 45 minutes). Never a replacement for the real gates: a strictly
 * faster, strictly cheaper filter that runs FIRST, so a run that would have failed anyway fails
 * fast instead of paying the full price to find out.
 *
 * THE TWO LIVE INCIDENTS THIS TARGETS (2026-07-20, acceptance test prompt C):
 *   1. A stray `]]>` CDATA-close artifact the model emitted, landing verbatim in a generated
 *      file — broke `npm run build`. Fixed at the source (engine/bolt/normalizer.ts strips it
 *      before writing), but `scanForStrayMarkers` is the regression-lock across ANY newly
 *      generated app, not just the one unit-tested input — and a defensive net for the next
 *      artifact shape the model invents that the specific strip regex doesn't cover.
 *   2. A migration hallucinating that `teams` is a view when it's a table — the `migrate` gate
 *      DID catch this correctly (it's the only gate that executes migrations against a real
 *      Postgres), but not until deep into a live 45-minute auto-fix cycle. `checkMigrations`
 *      does the SAME kind of check — execute the DDL against a real Postgres engine — in-memory,
 *      in milliseconds, via the already-a-dependency embedded pglite.
 *
 * `typecheckOnly` catches the single largest class of build failure (per fleet.ts's own SEED
 * conventions: async-API misuse, wrong client exports, arity mismatches — all TS errors) without
 * the ~10 minutes a from-scratch `npm ci` + `next build` costs.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DERIVED_DIRS } from "../gate/scan-scope.ts";
import { parseMigrations } from "../substrate/deploy-app.ts";
import { neutralize, SUPABASE_STUBS } from "@vibehard/gate-check";

export interface FastFinding {
  check: "stray-marker" | "typecheck" | "migration-ddl";
  file: string;
  message: string;
}

const DERIVED = new Set<string>(DERIVED_DIRS);
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sql", ".md"]);

function* walkFiles(root: string, dir = root): Generator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — nothing to walk
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (DERIVED.has(e.name)) continue;
      yield* walkFiles(root, join(dir, e.name));
    } else if (e.isFile() && SOURCE_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) {
      yield join(dir, e.name);
    }
  }
}

// Anchored to a line by itself (only whitespace around it) — a real code file legitimately
// containing this text mid-expression (e.g. a string literal) is untouched; only a marker
// sitting alone, the exact shape both live incidents took, is flagged.
const LONE_MARKER_RE = /^\s*(<!\[CDATA\[|\]\]>|<\/?bolt(Action|Artifact)\b[^>]*>)\s*$/;

/** Scan every authored source file for a stray protocol/escaping artifact sitting alone on its
 *  own line — the shape a truncated or confused model response leaves behind when a wrapper
 *  marker escapes the file-extraction step instead of the file's own content. */
export function scanForStrayMarkers(workspacePath: string): FastFinding[] {
  const findings: FastFinding[] = [];
  for (const file of walkFiles(workspacePath)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable (race, symlink, binary) — not this check's job to flag
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = LONE_MARKER_RE.exec(lines[i]!);
      if (m) findings.push({ check: "stray-marker", file: join(".", file.slice(workspacePath.length)), message: `stray "${m[1]}" on its own line (${i + 1}) — looks like a leaked protocol/escaping artifact, not real content` });
    }
    // An odd count of markdown code fences in a non-.md file is the other deferred-fidelity
    // gap bolt's normalizer.ts flags (fence stripping never ported) — a fence that opened but
    // never closed (or vice versa) means the file's real content got cut off mid-response.
    if (!file.endsWith(".md")) {
      const fences = (text.match(/```/g) ?? []).length;
      if (fences % 2 !== 0) findings.push({ check: "stray-marker", file: join(".", file.slice(workspacePath.length)), message: `an odd number of "\`\`\`" fences (${fences}) — the file likely got cut off mid-response` });
    }
  }
  return findings;
}

/** Run `tsc --noEmit` directly against the workspace — the single largest class of generated-app
 *  build failure, caught in seconds instead of the ~10 minutes a from-scratch npm ci + next build
 *  costs. Skipped (passed: true, no findings) when there's no tsconfig.json — not every generated
 *  stack is TypeScript. */
export async function typecheckOnly(workspacePath: string): Promise<{ passed: boolean; findings: FastFinding[] }> {
  if (!(await Bun.file(join(workspacePath, "tsconfig.json")).exists())) return { passed: true, findings: [] };
  const proc = Bun.spawnSync(["bunx", "tsc", "--noEmit"], { cwd: workspacePath, stdout: "pipe", stderr: "pipe" });
  if ((proc.exitCode ?? 1) === 0) return { passed: true, findings: [] };
  const out = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`.trim();
  // tsc prints one diagnostic per line ("file.ts(12,3): error TS2345: ..."); surface each as its
  // own finding (capped) rather than one giant blob, matching how every other gate reports.
  const lines = out.split("\n").filter((l) => /error TS\d+/.test(l));
  const findings: FastFinding[] = (lines.length ? lines : [out]).slice(0, 20).map((l) => ({ check: "typecheck", file: l.split("(")[0] || "(unknown)", message: l.trim() }));
  return { passed: false, findings };
}

/**
 * Execute every generated migration, in order, against a fresh EMBEDDED Postgres (pglite — a real
 * Postgres engine, already a dependency, no network/Docker) — the exact check the `migrate` gate
 * does live, in milliseconds instead of minutes. Skipped when there's no supabase/migrations dir
 * (not every generated stack has one).
 *
 * Seeded with the SAME `SUPABASE_STUBS`/`neutralize` the real `migrate` gate uses (migrate.ts) —
 * NOT a fresh ad hoc stub. Found live running this check's first live smoke test (2026-07-21): a
 * bare pglite has no `auth` schema at all (that's Supabase-specific, not vanilla Postgres), so a
 * migration correctly using `auth.uid()` in an RLS policy — the standard, CORRECT Supabase
 * pattern, not a bug — failed with "schema auth does not exist". Reusing the real gate's stub
 * closes that false positive and keeps this check's environment identical to what actually
 * decides pass/fail later, so the two can never quietly diverge.
 */
export async function checkMigrations(workspacePath: string): Promise<{ passed: boolean; findings: FastFinding[] }> {
  const migrations = parseMigrations(workspacePath);
  if (!migrations.length) return { passed: true, findings: [] };
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.exec(SUPABASE_STUBS);
    const findings: FastFinding[] = [];
    for (const m of migrations) {
      try {
        await db.exec(neutralize(m.sql));
      } catch (e) {
        findings.push({ check: "migration-ddl", file: join("supabase/migrations", m.id), message: e instanceof Error ? e.message : String(e) });
        break; // a later migration likely depends on this one — no point reporting cascading noise
      }
    }
    return { passed: findings.length === 0, findings };
  } finally {
    await db.close();
  }
}

/** Run every fast check; short-circuits are the caller's call (each check is independent and
 *  cheap enough to always run — the value is in running ALL of them before the expensive gate
 *  chain, not in skipping some). */
export async function fastPreCheck(workspacePath: string): Promise<{ passed: boolean; findings: FastFinding[] }> {
  const marker = scanForStrayMarkers(workspacePath);
  const [tsc, migrate] = await Promise.all([typecheckOnly(workspacePath), checkMigrations(workspacePath)]);
  const findings = [...marker, ...tsc.findings, ...migrate.findings];
  return { passed: findings.length === 0, findings };
}
