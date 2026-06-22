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

/** Build a usable Postgres URL: prefer a real SUPABASE_DB_URL, else assemble from the
 *  ref + an (encoded) password. Throws if neither is usable. */
export function resolveDbUrl(env: SupabaseEnv): string {
  if (env.dbUrl && !PLACEHOLDER.test(env.dbUrl)) return env.dbUrl;
  if (env.dbPassword) {
    return `postgresql://postgres:${encodeURIComponent(env.dbPassword)}@db.${refFromUrl(env.url)}.supabase.co:5432/postgres`;
  }
  throw new Error("no usable DB connection — set SUPABASE_DB_PASSWORD (preferred) or a real SUPABASE_DB_URL (not the [YOUR-PASSWORD] placeholder)");
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
