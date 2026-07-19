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
import { PgRecordStore, PgSecretsStore, type Sql } from "../platform/pg-store.ts";
import type { Migration, RecordStore, SecretsStore } from "./types.ts";

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
 * UNLESS a durable-DB `sql` runner is injected (EPIC #33b/#33c), in which case both go to the
 * Postgres-backed stores instead (scoped per tenant so a cloud box restart/redeploy doesn't lose
 * them). The HOST is chosen by artifact: a Dockerfile in the workspace → Fly (container deploy,
 * any language); otherwise Vercel (JS/TS-native). One signal — the presence of a Dockerfile —
 * used consistently with the verify gate's launch detection and FlyHostProvider's own precondition.
 */
export function defaultSubstrateDeps(
  opts: {
    stateDir?: string;
    onStep?: (m: string) => void;
    workspacePath?: string;
    managed?: boolean;
    appName?: string;
    sql?: Sql; // durable-DB query runner; when set, records + secrets use the Pg-backed stores
    scope?: string; // tenant id the Pg-backed stores are scoped under (defaults to appName, then "default")
    /** An explicit RecordStore override — wins over the sql/file fallback below. THE SEAM THIS
     *  EXISTS FOR (found live 2026-07-19, acceptance test prompt C): `deployApp`'s only real
     *  caller, `cli.ts ship`, runs as a bare subprocess with no live `sql` connection — on the
     *  platform host OR (production) inside an ephemeral E2B sandbox. Without this, EVERY
     *  sandboxed ship fell back to FileRecordStore under `~/.vibehard/deployments`, a path
     *  outside the workspace the build-worker's checkpoint tars — so it never survived a
     *  teardown, and every ship of the SAME app silently provisioned a BRAND NEW Supabase
     *  project instead of reusing the last one (data loss + orphaned projects burning quota).
     *  cli.ts now passes an httpRecordStore (record-client.ts) here when the sandbox has been
     *  given a platform base URL + dispatch token, restoring cross-dispatch durability without
     *  ever handing the sandbox a raw DB connection. */
    records?: RecordStore;
    /** An explicit SecretsStore override — wins over the sql/file fallback below. THE SEAM THIS
     *  EXISTS FOR (found live 2026-07-19, three ship attempts in a row, ~9.5 minutes of a fully-
     *  exhausted RLS retry budget each time): the RECORD-store fix above made projectRef/
     *  appliedMigrations/hostRef durable, but `ensureProject`'s REUSE path ALSO needs the
     *  project's full connection (url/anonKey/serviceKey/dbHost/dbPassword) from `secrets` — which
     *  had the IDENTICAL non-durability defect (LocalEncryptedSecretsStore under
     *  `~/.vibehard/secrets`, gone on sandbox teardown). On a reuse, that returned null, and
     *  ensureProject silently fell through to `this.env`'s EMPTY constructor default — every
     *  live-RLS probe then hit a URL with NO HOST for the entire retry budget; no amount of
     *  waiting could ever have fixed it. cli.ts now passes an httpSecretsStore
     *  (secrets-client.ts) here alongside `records`, over the SAME scoped channel. */
    secrets?: SecretsStore;
  } = {},
): SubstrateDeps {
  const stateDir = opts.stateDir ?? join(homedir(), ".vibehard");
  const containerized = !!opts.workspacePath && existsSync(join(opts.workspacePath, "Dockerfile"));
  const passphrase = process.env.VIBEHARD_SECRETS_KEY ?? "";
  const scope = opts.scope ?? opts.appName ?? "default";
  const secrets = opts.secrets ?? (opts.sql ? new PgSecretsStore(opts.sql, passphrase, scope) : new LocalEncryptedSecretsStore(join(stateDir, "secrets"), passphrase));
  const records = opts.records ?? (opts.sql ? new PgRecordStore(opts.sql, scope) : new FileRecordStore(join(stateDir, "deployments")));
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
    records,
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
  records?: RecordStore; // see defaultSubstrateDeps' own doc — the sandboxed-ship durability seam
  secrets?: SecretsStore; // see defaultSubstrateDeps' own doc — the SAME durability seam, one layer deeper
  hostNameSeed?: string; // see DeployInput's own doc — decoupled from `app`/the record-store key
}

/** Pure-ish (fs reads): does this workspace need a backend at all? A client-only app — no
 *  migrations, no supabase/ directory, no @supabase/* dependency — has nothing to provision;
 *  ship deploys the frontend only (orchestrator.ts `backendless`). Deliberately conservative:
 *  ANY supabase signal → false (provision as before). */
export function isBackendlessWorkspace(workspacePath: string, migrations: Migration[]): boolean {
  if (migrations.length > 0) return false;
  if (existsSync(join(workspacePath, "supabase"))) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(workspacePath, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    if (Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).some((d) => d.startsWith("@supabase/"))) return false;
  } catch {
    /* unreadable/absent manifest declares no supabase dependency */
  }
  return true;
}

/** A gate-passed app workspace → a live app. Derives migrations + RLS tables, runs the orchestrator. */
export async function deployApp(workspacePath: string, opts: DeployAppOptions = {}): Promise<DeployOutcome> {
  const app = opts.app ?? basename(workspacePath);
  // Managed (auto-create a project per app): forced by the caller (e.g. deployForTenant) or,
  // failing that, opt-in via VIBEHARD_MANAGED=1. Default = adopt the env project.
  const managed = opts.managed ?? process.env.VIBEHARD_MANAGED === "1";
  const deps =
    opts.deps ??
    defaultSubstrateDeps({ stateDir: opts.stateDir, onStep: opts.onStep, workspacePath, managed, appName: app, sql: opts.sql, scope: opts.scope, records: opts.records, secrets: opts.secrets });
  const migrations = parseMigrations(workspacePath);
  const rlsTables = tablesFromMigrations(migrations);
  const rlsEnabledTables = rlsEnabledTablesFromMigrations(migrations);
  const orgRef = process.env.SUPABASE_URL ? refFromUrl(process.env.SUPABASE_URL) : "default";
  // backlog #5: the app's third-party creds (declared in its .env.example) come in via the process
  // env (the web injects the tenant's saved values; a CLI user exports them) → injected at runtime.
  const appEnv = collectAppEnv(requiredCredentialsForApp(workspacePath), process.env);
  return provisionAndDeploy({ app, org: { orgRef }, workspacePath, migrations, rlsTables, rlsEnabledTables, appEnv, backendless: isBackendlessWorkspace(workspacePath, migrations), hostNameSeed: opts.hostNameSeed }, deps);
}
