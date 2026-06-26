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
 * verifyLiveRls is fail-CLOSED: it flags a table whose migrations never enabled RLS (leak even when
 * empty), a live anon read that returns rows (leak), and anything it cannot prove (inconclusive→block).
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
  SecretsStore,
} from "./types.ts";
import { readManagementToken, SupabaseManagementClient } from "./supabase-management.ts";

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
  /** Managed mode: auto-CREATE a project per app via the Management API (vs adopt-existing). */
  managed?: boolean;
  appName?: string; // the new project's name (managed mode)
  management?: SupabaseManagementClient; // injectable (managed mode); defaults to a real client
  orgId?: string; // SUPABASE_ORG_ID — optional; the sole org is auto-discovered otherwise
  secretsStore?: SecretsStore; // managed mode: persist a created project's connection so a redeploy can reload it
}

const EMPTY_ENV: SupabaseEnv = { url: "", anonKey: "", serviceKey: "" };

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
  // env is mutable: in managed mode ensureProject points it at the freshly-created project
  // so applyMigrations + verifyLiveRls (which read this.env lazily) operate on the new project.
  private env: SupabaseEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly executorFactory: () => DbExecutor;
  private readonly managed: boolean;
  private readonly appName?: string;
  private readonly management?: SupabaseManagementClient;
  private readonly orgId?: string;
  private readonly secretsStore?: SecretsStore;

  constructor(opts: SupabaseProviderOptions = {}) {
    this.managed = opts.managed ?? false;
    this.appName = opts.appName;
    this.management = opts.management;
    this.orgId = opts.orgId;
    this.secretsStore = opts.secretsStore;
    // In managed mode the project doesn't exist yet → start with an empty env that
    // ensureProject fills in. Adopt mode reads the existing project's creds from env now.
    this.env = opts.env ?? (this.managed ? { ...EMPTY_ENV } : envFromProcess());
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.executorFactory = opts.executorFactory ?? (() => bunExecutor(resolveDbUrl(this.env)));
  }

  /**
   * Reuse → managed-create → adopt-existing, in that order:
   *  • a record with a projectRef → reuse it (idempotent redeploy);
   *  • managed mode → CREATE a fresh Supabase project for this app via the Management API,
   *    then point this provider at it (the rest of the deploy runs against the new project);
   *  • otherwise → adopt the project named in the environment (v1 single-project behavior).
   */
  async ensureProject(record: DeploymentRecord, _org: CustomerOrg): Promise<{ handle: BackendHandle; secrets: BackendSecrets }> {
    if (record.projectRef) {
      // Managed reuse (redeploy): the project was auto-created on a prior deploy. Reload its FULL
      // connection — including the generated db password, which the Management API can't re-issue —
      // from the encrypted store, and repoint this provider so re-migration + the RLS probe hit it.
      if (this.managed && this.secretsStore) {
        const stored = await this.secretsStore.get(record.app);
        if (stored) {
          this.env = { url: stored.url, anonKey: stored.anonKey, serviceKey: stored.serviceKey, dbHost: stored.dbHost, dbPassword: stored.dbPassword };
          return { handle: { projectRef: record.projectRef }, secrets: stored };
        }
      }
      const secrets: BackendSecrets = { url: this.env.url, anonKey: this.env.anonKey, serviceKey: this.env.serviceKey };
      return { handle: { projectRef: record.projectRef }, secrets };
    }
    if (this.managed) {
      const mgmt = this.management ?? new SupabaseManagementClient({ token: readManagementToken() });
      const p = await mgmt.provisionProject({ name: this.appName ?? "vibehard-app", orgId: this.orgId });
      // operate the remainder of the deploy on the NEW project
      this.env = { url: p.url, anonKey: p.anonKey, serviceKey: p.serviceKey, dbPassword: p.dbPassword, dbHost: p.dbHost };
      // Persist the FULL connection (incl. the unrecoverable db password) so a future redeploy can
      // reload it — the fix for managed redeploys. Encrypted at rest; never injected into the host.
      const secrets: BackendSecrets = { url: p.url, anonKey: p.anonKey, serviceKey: p.serviceKey, dbHost: p.dbHost, dbUser: p.dbUser, dbPassword: p.dbPassword };
      if (this.secretsStore) await this.secretsStore.put(record.app, secrets);
      return { handle: { projectRef: p.ref }, secrets };
    }
    const projectRef = refFromUrl(this.env.url);
    return { handle: { projectRef }, secrets: { url: this.env.url, anonKey: this.env.anonKey, serviceKey: this.env.serviceKey } };
  }

  /** Apply only the not-yet-applied migrations over a direct Postgres connection. A SQL
   *  error stops immediately (returns ok:false) — the orchestrator aborts the deploy. */
  async applyMigrations(_handle: BackendHandle, migrations: Migration[], alreadyApplied: string[]): Promise<MigrationResult> {
    const todo = migrations.filter((m) => !alreadyApplied.includes(m.id));
    const appliedNow: string[] = [];
    if (!todo.length) return { ok: true, appliedNow }; // nothing to do → open no connection
    const db = this.executorFactory();
    try {
      // A DB-side ledger is the SOURCE OF TRUTH for what's applied — idempotent even if the side-file
      // record was lost between apply and write (the old behavior re-ran a non-idempotent migration on
      // resume, e.g. CREATE POLICY → "already exists"). The ledger insert goes FIRST in the txn, so a
      // re-applied migration conflicts on the PK and the whole txn (incl. the migration SQL) rolls back.
      await db.exec(`create table if not exists _vibehard_migrations (id text primary key, applied_at timestamptz not null default now());`);
      for (const m of todo) {
        const id = `'${m.id.replace(/'/g, "''")}'`;
        try {
          await db.exec(`begin;\ninsert into _vibehard_migrations (id) values (${id});\n${m.sql}\n;\ncommit;`);
          appliedNow.push(m.id);
        } catch (e) {
          await db.exec("rollback;").catch(() => {});
          const message = msg(e);
          if (/_vibehard_migrations/i.test(message)) continue; // already in the ledger → already applied → skip, not an error
          return { ok: false, appliedNow, error: `migration ${m.id}: ${message}` };
        }
      }
      return { ok: true, appliedNow };
    } finally {
      await db.end().catch(() => {});
    }
  }

  /**
   * THE differentiated step, now fail-CLOSED. Two checks: (1) STATIC — a table the migrations never
   * enabled RLS on is a leak even if it's empty today (the old probe only caught tables that already
   * had rows, so a fresh app passed trivially); (2) LIVE — a real anonymous REST query that returns
   * rows is a leak (CVE-2025-48757). A 200-empty on an RLS-enabled table or a 401/403 is "denied".
   * Anything we cannot prove (transport error, odd response) is INCONCLUSIVE → enforced=false → abort.
   */
  async verifyLiveRls(_handle: BackendHandle, tables: string[], rlsEnabled: string[] = []): Promise<LiveRlsResult> {
    const enabled = new Set(rlsEnabled);
    const knowEnabled = rlsEnabled.length > 0; // were we told which tables are RLS-protected?
    const leakedTables: string[] = [];
    const inconclusive: string[] = [];
    for (const t of tables) {
      // STATIC cross-check (closes the empty-table blind spot): a table the migrations never enabled
      // RLS on is a definite leak even with zero rows today — anon would read every future row. The old
      // probe only flagged a table that ALREADY had rows, so a fresh app (all tables empty) always passed.
      if (knowEnabled && !enabled.has(t)) {
        leakedTables.push(t);
        continue;
      }
      const url = `${this.env.url}/rest/v1/${encodeURIComponent(t)}?select=*&limit=1`;
      try {
        const res = await this.fetchImpl(url, { headers: { apikey: this.env.anonKey, Authorization: `Bearer ${this.env.anonKey}` } });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as unknown;
          if (Array.isArray(body) && body.length > 0) leakedTables.push(t); // anon SAW rows → leak
          else if (!Array.isArray(body)) inconclusive.push(t); // unexpected 200 shape → can't prove denial
          // 200 + [] on an RLS-enabled table → anon denied → secure
        } else if (res.status === 401 || res.status === 403) {
          // anon explicitly denied → secure
        } else {
          inconclusive.push(t); // 404/5xx/other → could not prove denial
        }
      } catch {
        inconclusive.push(t); // transport error → FAIL CLOSED (was: silently treated as enforced)
      }
    }
    return { enforced: leakedTables.length === 0 && inconclusive.length === 0, leakedTables, inconclusive };
  }

  /** v1 no-op: redirect-URL / provider config needs the Management API (PAT, deferred). */
  async configureAuth(_handle: BackendHandle, _appUrl: string): Promise<void> {
    /* deferred — done in the dashboard for now */
  }

  /** Adopt-existing model: VibeHard is the processor, not the owner — it never deletes the
   *  customer's project. Teardown removes VibeHard's own artifacts elsewhere. */
  async deleteProject(_handle: BackendHandle): Promise<void> {
    /* intentionally not supported in the adopt-existing model */
  }
}
