/**
 * The MIGRATE gate — the fix for the highest-value gap found shipping ProCare live: every other
 * gate checks the database migrations as TEXT (static analysis) and none ever APPLIES them to a real
 * Postgres. So a migration that compiles-looking-but-is-invalid sails through and only explodes at
 * deploy. Four real bugs slipped past all gates this way: invalid `FOR INSERT UPDATE DELETE` policy
 * syntax, a forward foreign key, helper-functions/policies referencing a table created later, and
 * RLS infinite recursion.
 *
 * This gate EXECUTES the migrations against an embedded in-process Postgres (pglite — no Docker
 * daemon, runs anywhere) seeded with the Supabase-compatible schema stubs a generated app expects
 * (auth.users / auth.uid() / auth.jwt() / storage.*). A migration that fails to apply is a blocking
 * finding, localized to the file + the Postgres error. Deterministic, LLM-free, ~1s.
 *
 * Scope (v1): catches everything that surfaces at DDL APPLY time — syntax, ordering, forward refs,
 * bad constraints. RLS-recursion-at-query-time and full app-boot smoke are tracked follow-ons.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";

/** Minimal Supabase environment so a real Supabase migration can execute off-platform. Exported so the
 *  RLS-enforcement harness (rls-enforce.ts) applies migrations in the IDENTICAL environment. */
export const SUPABASE_STUBS = `
-- Standard Supabase roles (migrations GRANT to / reference these; they exist on a real project).
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE authenticator NOINHERIT;
  CREATE ROLE supabase_auth_admin NOLOGIN;
  CREATE ROLE supabase_storage_admin NOLOGIN;
  CREATE ROLE supabase_admin NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT anon, authenticated, service_role TO authenticator;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true),'') $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb,'{}'::jsonb) $$;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text primary key, name text not null, owner uuid, owner_id text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  public boolean default false, avif_autodetection boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, owner_id text, version text,
  created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz default now(),
  metadata jsonb, user_metadata jsonb, path_tokens text[]
);
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
-- uuid-ossp shim: pglite has gen_random_uuid() built in; alias the ossp name so migrations that call it work.
CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
`;

/** Strip statements pglite can't honor but that are no-ops for schema validity (extension installs we
 *  shim above). We DON'T rewrite real DDL — only neutralize known-safe-to-stub lines. */
export function neutralize(sql: string): string {
  return sql.replace(/CREATE EXTENSION[^;]*;/gi, "-- (extension shimmed by the migrate gate)");
}

export interface MigrateOptions {
  ranAt?: string;
  /** Injectable applier for tests (default: real pglite). Returns null on success, or an error message. */
  apply?: (statementsInOrder: Array<{ file: string; sql: string }>) => Promise<{ file: string; error: string } | null>;
}

async function pgliteApplier(files: Array<{ file: string; sql: string }>): Promise<{ file: string; error: string } | null> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.exec(SUPABASE_STUBS);
    for (const { file, sql } of files) {
      try {
        await db.exec(neutralize(sql));
      } catch (e) {
        return { file, error: (String(e instanceof Error ? e.message : e).split("\n")[0] ?? "apply failed").slice(0, 300) };
      }
    }
    return null;
  } finally {
    await db.close();
  }
}

export async function runMigrate(projectPath: string, opts: MigrateOptions = {}): Promise<GateVerdict> {
  const ranAt = opts.ranAt ?? new Date().toISOString();
  const dir = join(projectPath, "supabase", "migrations");
  if (!existsSync(dir)) return verdictOf("migrate", [], ranAt); // no migrations → N/A

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ file: join("supabase/migrations", f), sql: readFileSync(join(dir, f), "utf8") }));
  if (!files.length) return verdictOf("migrate", [], ranAt);

  const applier = opts.apply ?? pgliteApplier;
  const failure = await applier(files);
  if (!failure) return verdictOf("migrate", [], ranAt); // every migration applied to a real Postgres ✓

  const finding: Finding = {
    tool: "migrate",
    ruleId: "migration-failed",
    severity: "high",
    file: failure.file,
    message: `This migration does NOT apply to a real Postgres: ${failure.error}. The other gates only read migrations as text — this one executes them. Fix the SQL so the schema actually builds (common causes: a CREATE POLICY "FOR" clause listing multiple commands instead of FOR ALL; a foreign key to a table created later; a function or policy that references a table defined further down; RLS recursion).`,
  };
  return verdictOf("migrate", [finding], ranAt);
}

export const migrateGate = { name: "migrate", run: (p: string) => runMigrate(p) };
