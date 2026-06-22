/**
 * SupabaseBackendProvider — the real BackendProvider, v1 "adopt an existing project"
 * (no Management-API project creation yet; that needs a PAT and is deferred). It reads
 * the customer's project creds from the environment, applies migrations over a direct
 * Postgres connection (Bun's native SQL), and runs the differentiated LIVE-RLS PROBE:
 * a real anonymous REST query that must NOT come back with rows.
 *
 * Boundaries (mirror the orchestrator + §16): the service-role key is used SERVER-SIDE
 * here (migrations/admin) and is never returned to the host env (the orchestrator injects
 * only url + anon). All DB/HTTP I/O is behind injectable seams so the logic unit-tests
 * with fakes — no live project required.
 *
 * Honest limit of verifyLiveRls: it proves a leak only when anon actually SEES a row.
 * On an empty table it can't (no row to leak), so the live spike SEEDS a row first. For
 * real deploys, tables are typically seeded or a canary is used.
 */
import { SQL } from "bun";
import type {
  BackendHandle,
  BackendProvider,
  BackendSecrets,
  CustomerOrg,
  DeploymentRecord,
  LiveRlsResult,
  Migration,
  MigrationResult,
} from "./types.ts";

/** The Supabase creds the provider needs. Defaults are read from process.env. */
export interface SupabaseEnv {
  url: string; // SUPABASE_URL (https://<ref>.supabase.co)
  anonKey: string; // SUPABASE_ANON_KEY (publishable / public)
  serviceKey: string; // SUPABASE_SERVICE_ROLE_KEY (secret — server-side only)
  dbUrl?: string; // SUPABASE_DB_URL (full; used only if real, not a placeholder)
  dbPassword?: string; // SUPABASE_DB_PASSWORD (preferred — we build the URL, no encoding footguns)
  dbHost?: string; // SUPABASE_DB_HOST — set to the pooler host (aws-N-<region>.pooler.supabase.com) for IPv4 + serverless
  dbPort?: number; // SUPABASE_DB_PORT — defaults to 5432 (session pooler / direct)
}

/** Minimal DB seam so applyMigrations is testable without a live Postgres. */
export interface DbExecutor {
  exec(sql: string): Promise<void>;
  end(): Promise<void>;
}

export interface SupabaseProviderOptions {
  env?: SupabaseEnv;
  fetchImpl?: typeof fetch; // for the live-RLS REST probe
  executorFactory?: () => DbExecutor; // defaults to a Bun-SQL executor over the resolved DB URL
}

const PLACEHOLDER = /your[-_ ]?password|\[|\]/i;

/** Project ref from the project URL: https://abc123.supabase.co → "abc123". */
export function refFromUrl(url: string): string {
  return new URL(url).hostname.split(".")[0]!;
}

/** Inject a password into a connection URL, preserving host/user/port. A [BRACKETED]
 *  placeholder is replaced by string surgery (brackets in userinfo break `new URL`);
 *  otherwise the WHATWG URL setter handles userinfo percent-encoding. */
function injectPassword(rawUrl: string, password: string): string {
  if (/:\[[^\]]*\]@/.test(rawUrl)) return rawUrl.replace(/:\[[^\]]*\]@/, `:${encodeURIComponent(password)}@`);
  const u = new URL(rawUrl);
  u.password = password;
  return u.toString();
}

/**
 * Resolve a usable Postgres URL. Priority:
 *   1. a complete SUPABASE_DB_URL (direct OR pooler) → use as-is;
 *   2. a SUPABASE_DB_URL with the [YOUR-PASSWORD] placeholder + SUPABASE_DB_PASSWORD →
 *      inject the password (keeps the pooler host/user);
 *   3. SUPABASE_DB_PASSWORD + SUPABASE_DB_HOST → assemble a POOLER connection
 *      (postgres.<ref>@host) — the IPv4 path for serverless deploys;
 *   4. just SUPABASE_DB_PASSWORD → assemble a DIRECT connection from the project ref.
 * Throws if none is usable.
 */
export function resolveDbUrl(env: SupabaseEnv): string {
  if (env.dbUrl) {
    if (!PLACEHOLDER.test(env.dbUrl)) return env.dbUrl;
    if (env.dbPassword) return injectPassword(env.dbUrl, env.dbPassword);
  }
  if (env.dbPassword) {
    const pw = encodeURIComponent(env.dbPassword);
    const port = env.dbPort ?? 5432;
    if (env.dbHost) {
      // pooler (Supavisor): the tenant ref rides in the username → postgres.<ref>
      return `postgresql://postgres.${refFromUrl(env.url)}:${pw}@${env.dbHost}:${port}/postgres`;
    }
    return `postgresql://postgres:${pw}@db.${refFromUrl(env.url)}.supabase.co:${port}/postgres`;
  }
  throw new Error("no usable DB connection — set SUPABASE_DB_PASSWORD (+ SUPABASE_DB_HOST for the pooler) or a real SUPABASE_DB_URL");
}

function envFromProcess(): SupabaseEnv {
  const need = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`SupabaseBackendProvider: missing ${k}`);
    return v;
  };
  return {
    url: need("SUPABASE_URL"),
    anonKey: need("SUPABASE_ANON_KEY"),
    serviceKey: need("SUPABASE_SERVICE_ROLE_KEY"),
    dbUrl: process.env.SUPABASE_DB_URL,
    dbPassword: process.env.SUPABASE_DB_PASSWORD,
    dbHost: process.env.SUPABASE_DB_HOST,
    dbPort: process.env.SUPABASE_DB_PORT ? Number(process.env.SUPABASE_DB_PORT) : undefined,
  };
}

/** Default executor over Bun's native Postgres client. `.simple()` runs the whole
 *  migration (multiple statements: create + enable RLS + policy) in one round-trip. */
function bunExecutor(url: string): DbExecutor {
  const db = new SQL(url);
  return {
    exec: async (sql: string) => {
      await db.unsafe(sql).simple();
    },
    end: () => db.end(),
  };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class SupabaseBackendProvider implements BackendProvider {
  readonly name = "supabase";
  private readonly env: SupabaseEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly executorFactory: () => DbExecutor;

  constructor(opts: SupabaseProviderOptions = {}) {
    this.env = opts.env ?? envFromProcess();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.executorFactory = opts.executorFactory ?? (() => bunExecutor(resolveDbUrl(this.env)));
  }

  /** v1: adopt the existing project from env (no Management-API creation). Idempotent. */
  async ensureProject(record: DeploymentRecord, _org: CustomerOrg): Promise<{ handle: BackendHandle; secrets: BackendSecrets }> {
    const projectRef = record.projectRef ?? refFromUrl(this.env.url);
    const secrets: BackendSecrets = { url: this.env.url, anonKey: this.env.anonKey, serviceKey: this.env.serviceKey };
    return { handle: { projectRef }, secrets };
  }

  /** Apply only the not-yet-applied migrations over a direct Postgres connection. A SQL
   *  error stops immediately (returns ok:false) — the orchestrator aborts the deploy. */
  async applyMigrations(_handle: BackendHandle, migrations: Migration[], alreadyApplied: string[]): Promise<MigrationResult> {
    const todo = migrations.filter((m) => !alreadyApplied.includes(m.id));
    const appliedNow: string[] = [];
    if (!todo.length) return { ok: true, appliedNow };
    const db = this.executorFactory();
    try {
      for (const m of todo) {
        try {
          await db.exec(m.sql);
          appliedNow.push(m.id);
        } catch (e) {
          return { ok: false, appliedNow, error: `migration ${m.id}: ${msg(e)}` };
        }
      }
      return { ok: true, appliedNow };
    } finally {
      await db.end().catch(() => {});
    }
  }

  /**
   * THE differentiated step. Fire a real ANONYMOUS REST query at each table; if it comes
   * back with rows, RLS is leaking (the CVE-2025-48757 failure) → not enforced. An empty
   * result or a permission error means anon is denied. Only proven leaks fail.
   */
  async verifyLiveRls(_handle: BackendHandle, tables: string[]): Promise<LiveRlsResult> {
    const leakedTables: string[] = [];
    for (const t of tables) {
      const url = `${this.env.url}/rest/v1/${encodeURIComponent(t)}?select=*&limit=1`;
      try {
        const res = await this.fetchImpl(url, { headers: { apikey: this.env.anonKey, Authorization: `Bearer ${this.env.anonKey}` } });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as unknown;
          if (Array.isArray(body) && body.length > 0) leakedTables.push(t); // anon SAW rows → leak
        }
        // non-2xx (401/403/404) → anon denied or table hidden → not a proven leak
      } catch {
        // network error → cannot prove a leak; do not fail enforcement on transport noise
      }
    }
    return { enforced: leakedTables.length === 0, leakedTables };
  }

  /** v1 no-op: redirect-URL / provider config needs the Management API (PAT, deferred). */
  async configureAuth(_handle: BackendHandle, _appUrl: string): Promise<void> {
    /* deferred — done in the dashboard for now */
  }

  /** Adopt-existing model: Drydock is the processor, not the owner — it never deletes the
   *  customer's project. Teardown removes Drydock's own artifacts elsewhere. */
  async deleteProject(_handle: BackendHandle): Promise<void> {
    /* intentionally not supported in the adopt-existing model */
  }
}
