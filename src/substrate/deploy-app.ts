/**
 * deployApp — the last-mile wiring (docs/runtime-substrate § W5). Assembles the REAL
 * providers (Supabase backend, Vercel host, encrypted secrets, file records) from the
 * environment and runs the deterministic `provisionAndDeploy` orchestrator on a gated,
 * passing app workspace. It derives the migrations (supabase/migrations/*.sql) and the
 * RLS-probe tables (the `create table`s) from the workspace. Zero LLM in this path (§11).
 *
 * The orchestrator enforces the HARD_VERIFY_PASS sentinel precondition, so deployApp can
 * only push an app the gate already passed (defense in depth — the CLI gates first too).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { collectAppEnv, requiredCredentialsForApp } from "../credentials/credentials.ts";
import { FileRecordStore } from "./record.ts";
import { LocalEncryptedSecretsStore } from "./secrets.ts";
import { refFromUrl, SupabaseBackendProvider } from "./supabase.ts";
import { VercelHostProvider } from "./vercel.ts";
import { FlyHostProvider } from "./fly.ts";
import { provisionAndDeploy, type DeployOutcome, type SubstrateDeps } from "./orchestrator.ts";
import { PgSecretsStore, type Sql } from "../platform/pg-store.ts";
import type { Migration } from "./types.ts";

/** Read the workspace's Supabase migrations (sorted by filename), each file → one Migration. */
export function parseMigrations(workspacePath: string): Migration[] {
  const dir = join(workspacePath, "supabase", "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ id: f, sql: readFileSync(join(dir, f), "utf8") }));
}

/** The tables the live-RLS probe should check — every `create table` in the migrations. */
export function tablesFromMigrations(migrations: Migration[]): string[] {
  const tables = new Set<string>();
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?/gi;
  for (const m of migrations) for (const match of m.sql.matchAll(re)) tables.add(match[1]!);
  return [...tables];
}

/** The subset that actually has RLS enabled (`enable row level security`). The probe treats any table
 *  NOT here as a definite leak — so an empty-but-unprotected table can't slip through at first deploy. */
export function rlsEnabledTablesFromMigrations(migrations: Migration[]): string[] {
  const enabled = new Set<string>();
  const re = /alter\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?\s+enable\s+row\s+level\s+security/gi;
  for (const m of migrations) for (const match of m.sql.matchAll(re)) enabled.add(match[1]!);
  return [...enabled];
}

/**
 * Assemble the real providers from env. Records + secrets live under stateDir (default ~/.vibehard),
 * UNLESS a durable-DB `sql` runner is injected (EPIC #33b), in which case secrets go to the
 * Postgres-backed store instead (scoped per tenant so a cloud box restart/redeploy doesn't lose
 * them) — records stay file-based for now (`RecordStore` is still a sync interface; PgRecordStore
 * needs its own async-flip, tracked separately). The HOST is chosen by artifact: a Dockerfile in
 * the workspace → Fly (container deploy, any language); otherwise Vercel (JS/TS-native). One
 * signal — the presence of a Dockerfile — used consistently with the verify gate's launch
 * detection and FlyHostProvider's own precondition.
 */
export function defaultSubstrateDeps(
  opts: {
    stateDir?: string;
    onStep?: (m: string) => void;
    workspacePath?: string;
    managed?: boolean;
    appName?: string;
    sql?: Sql; // durable-DB query runner; when set, secrets use PgSecretsStore instead of the local file store
    scope?: string; // tenant id the Pg-backed secrets are scoped under (defaults to appName, then "default")
  } = {},
): SubstrateDeps {
  const stateDir = opts.stateDir ?? join(homedir(), ".vibehard");
  const containerized = !!opts.workspacePath && existsSync(join(opts.workspacePath, "Dockerfile"));
  const passphrase = process.env.VIBEHARD_SECRETS_KEY ?? "";
  const secrets = opts.sql
    ? new PgSecretsStore(opts.sql, passphrase, opts.scope ?? opts.appName ?? "default")
    : new LocalEncryptedSecretsStore(join(stateDir, "secrets"), passphrase);
  return {
    // Managed mode → auto-CREATE a Supabase project per app (Management API); else adopt the
    // project named in the environment (single-project v1). Managed needs no SUPABASE_URL/keys.
    // The SAME secrets store is shared so the provider can reload a created project's connection
    // (incl. the generated db password) on a later redeploy.
    backend: opts.managed
      ? new SupabaseBackendProvider({ managed: true, appName: opts.appName, secretsStore: secrets })
      : new SupabaseBackendProvider(),
    host: containerized ? new FlyHostProvider() : new VercelHostProvider(),
    secrets,
    records: new FileRecordStore(join(stateDir, "deployments")),
    onStep: opts.onStep,
  };
}

export interface DeployAppOptions {
  app?: string; // defaults to the workspace dir basename
  deps?: SubstrateDeps; // defaults to defaultSubstrateDeps (the real providers)
  stateDir?: string;
  onStep?: (message: string) => void;
  managed?: boolean; // force managed (auto-create a project); defaults to the VIBEHARD_MANAGED env flag
  sql?: Sql; // durable-DB query runner; when set, secrets use PgSecretsStore (EPIC #33b)
  scope?: string; // tenant id the Pg-backed secrets are scoped under
}

/** A gate-passed app workspace → a live app. Derives migrations + RLS tables, runs the orchestrator. */
export async function deployApp(workspacePath: string, opts: DeployAppOptions = {}): Promise<DeployOutcome> {
  const app = opts.app ?? basename(workspacePath);
  // Managed (auto-create a project per app): forced by the caller (e.g. deployForTenant) or,
  // failing that, opt-in via VIBEHARD_MANAGED=1. Default = adopt the env project.
  const managed = opts.managed ?? process.env.VIBEHARD_MANAGED === "1";
  const deps =
    opts.deps ??
    defaultSubstrateDeps({ stateDir: opts.stateDir, onStep: opts.onStep, workspacePath, managed, appName: app, sql: opts.sql, scope: opts.scope });
  const migrations = parseMigrations(workspacePath);
  const rlsTables = tablesFromMigrations(migrations);
  const rlsEnabledTables = rlsEnabledTablesFromMigrations(migrations);
  const orgRef = process.env.SUPABASE_URL ? refFromUrl(process.env.SUPABASE_URL) : "default";
  // backlog #5: the app's third-party creds (declared in its .env.example) come in via the process
  // env (the web injects the tenant's saved values; a CLI user exports them) → injected at runtime.
  const appEnv = collectAppEnv(requiredCredentialsForApp(workspacePath), process.env);
  return provisionAndDeploy({ app, org: { orgRef }, workspacePath, migrations, rlsTables, rlsEnabledTables, appEnv }, deps);
}
