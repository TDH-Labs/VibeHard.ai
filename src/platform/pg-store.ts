/**
 * Durable (Postgres) persistence for the hosted platform (production-readiness loop, EPIC #33).
 *
 * The platform's stores are file/memory-backed — fine for a local single process, but a cloud box
 * wipes that on every restart/redeploy, so a user's signup + their builds wouldn't survive. This adds
 * Postgres-backed stores behind an INJECTED query runner (`Sql`): unit-tested on embedded Postgres
 * (pglite, already a dep) here, and run against managed Postgres (`DATABASE_URL`) at deploy via a
 * postgres.js adapter added at wiring time. The legacy stores are synchronous; Postgres is async, so
 * these are async and Platform/web move to async to use them (the follow-on increment).
 */
import type { Tenant, TenantStore } from "./types.ts";
import type { BackendSecrets, DeploymentRecord } from "../substrate/types.ts";
import { sealJson, unsealJson } from "../substrate/seal.ts";
import { claimTicket, openTicket, resolveTicket, ticketId, type EscalationPacket, type EscalationSink, type EscalationTicket, type ReviewDecision, type TicketState } from "../escalation/index.ts";

export type Row = Record<string, unknown>;
/** Minimal query-runner the stores depend on. pglite (tests) and postgres.js (prod) both adapt to it. */
export type Sql = (query: string, params?: unknown[]) => Promise<Row[]>;

/** Adapt @electric-sql/pglite to the Sql shape (used by tests + an embedded fallback). */
export function pgliteSql(db: { query: <T>(q: string, p?: unknown[]) => Promise<{ rows: T[] }> }): Sql {
  return async (q, p) => (await db.query<Row>(q, p)).rows;
}

/** Create the platform tables if absent. Idempotent — safe to call on every boot. */
export async function ensurePlatformSchema(sql: Sql): Promise<void> {
  await sql(
    `create table if not exists tenants (
       id text primary key,
       name text not null,
       plan text not null,
       status text not null,
       created_at text not null
     )`,
  );
}

function rowToTenant(r: Row): Tenant {
  return {
    id: String(r.id),
    name: String(r.name),
    plan: String(r.plan),
    status: String(r.status) as Tenant["status"],
    createdAt: String(r.created_at),
  };
}

/**
 * Postgres-backed tenant store — the async durable equivalent of FileTenantStore. Holds the
 * tenant + plan + status that billing/quota decisions read, so it MUST survive restarts.
 */
export class PgTenantStore implements TenantStore {
  constructor(private readonly sql: Sql) {}

  async create(t: Tenant): Promise<void> {
    await this.sql(
      `insert into tenants (id, name, plan, status, created_at) values ($1, $2, $3, $4, $5)
       on conflict (id) do nothing`,
      [t.id, t.name, t.plan, t.status, t.createdAt],
    );
  }

  async get(id: string): Promise<Tenant | null> {
    const rows = await this.sql(`select id, name, plan, status, created_at from tenants where id = $1`, [id]);
    return rows[0] ? rowToTenant(rows[0]) : null;
  }

  async list(): Promise<Tenant[]> {
    const rows = await this.sql(`select id, name, plan, status, created_at from tenants order by created_at`);
    return rows.map(rowToTenant);
  }

  /** Update mutable fields (plan/status/name) — id + created_at are immutable. */
  async update(t: Tenant): Promise<void> {
    await this.sql(`update tenants set name = $2, plan = $3, status = $4 where id = $1`, [t.id, t.name, t.plan, t.status]);
  }
}

/** Substrate tables: deployment records + encrypted app secrets, both scoped by tenant. Idempotent. */
export async function ensureSubstrateSchema(sql: Sql): Promise<void> {
  await sql(`create table if not exists deployments (scope text not null, app text not null, data text not null, primary key (scope, app))`);
  await sql(`create table if not exists app_secrets (scope text not null, app text not null, blob text not null, primary key (scope, app))`);
}

/** Escalation tickets, scoped by tenant, looked up by the ticket's own (content-hash) id — same
 *  key shape as LocalEscalationSink's one-file-per-ticket model. Which (tenantId, app) a caller is
 *  allowed to touch is enforced one layer up (authorizeRecordRequest / the Clerk session's own
 *  tenantId), not by a column here — `EscalationPacket` itself carries no app id to key on. */
export async function ensureEscalationSchema(sql: Sql): Promise<void> {
  await sql(`create table if not exists escalation_tickets (scope text not null, id text not null, data text not null, primary key (scope, id))`);
}

/**
 * Postgres-backed deployment records — the async durable equivalent of the file RecordStore. Scoped
 * per tenant (matching the file store's per-tenant rooting); the record is stored as JSON so its shape
 * can evolve without a migration.
 */
export class PgRecordStore {
  constructor(
    private readonly sql: Sql,
    private readonly scope: string,
  ) {}

  async get(app: string): Promise<DeploymentRecord | null> {
    const rows = await this.sql(`select data from deployments where scope = $1 and app = $2`, [this.scope, app]);
    if (!rows[0]) return null;
    try {
      return JSON.parse(String(rows[0].data)) as DeploymentRecord;
    } catch {
      return null;
    }
  }

  async put(record: DeploymentRecord): Promise<void> {
    await this.sql(
      `insert into deployments (scope, app, data) values ($1, $2, $3)
       on conflict (scope, app) do update set data = excluded.data`,
      [this.scope, record.app, JSON.stringify(record)],
    );
  }

  async remove(app: string): Promise<void> {
    await this.sql(`delete from deployments where scope = $1 and app = $2`, [this.scope, app]);
  }
}

/**
 * Postgres-backed encrypted secrets store — the async durable equivalent of LocalEncryptedSecretsStore.
 * Same AES-256-GCM seal (shared seal.ts), ciphertext stored in Postgres instead of a file so it
 * survives a restart + is reachable from any instance. Scoped per tenant. The secretsRef is the app id.
 */
export class PgSecretsStore {
  readonly name = "pg-encrypted";
  constructor(
    private readonly sql: Sql,
    private readonly passphrase: string,
    private readonly scope: string,
  ) {
    if (!passphrase) throw new Error("PgSecretsStore needs a passphrase (set VIBEHARD_SECRETS_KEY)");
  }

  async put(app: string, secrets: BackendSecrets): Promise<string> {
    await this.sql(
      `insert into app_secrets (scope, app, blob) values ($1, $2, $3)
       on conflict (scope, app) do update set blob = excluded.blob`,
      [this.scope, app, sealJson(secrets, this.passphrase)],
    );
    return app;
  }

  async get(app: string): Promise<BackendSecrets | null> {
    const rows = await this.sql(`select blob from app_secrets where scope = $1 and app = $2`, [this.scope, app]);
    if (!rows[0]) return null;
    return unsealJson<BackendSecrets>(String(rows[0].blob), this.passphrase);
  }

  async remove(app: string): Promise<void> {
    await this.sql(`delete from app_secrets where scope = $1 and app = $2`, [this.scope, app]);
  }
}

/**
 * Postgres-backed escalation queue — the async durable equivalent of LocalEscalationSink.
 *
 * THE BUG THIS CLOSES (found live 2026-07-20, acceptance test prompt C, second retry): a held
 * build's escalation ticket is opened by `runAutoFixAndReport` (cli.ts) from WHEREVER the gate/fix
 * loop actually runs — in production that's an ephemeral E2B sandbox, not the platform box. Local-
 * EscalationSink writes the ticket to `~/.vibehard/queue` on WHATEVER machine is running, which for
 * a sandboxed build is the sandbox's own disk. `/api/held` then asks the PLATFORM's own
 * LocalEscalationSink for that ticket id and finds nothing — the sandbox and its ticket file were
 * both destroyed the moment the build held. Every E2B-dispatched held build has therefore been
 * silently unexplainable: "held by the gates" with zero findings shown, defeating the exact
 * transparency ("every gate, shown") the product promises. Same architectural defect as the
 * deployment-record and backend-secrets bugs fixed the day before; this is the third instance.
 *
 * Reuses the SAME pure state-machine (openTicket/claimTicket/resolveTicket) LocalEscalationSink
 * uses — only the persistence changed, not the transition rules.
 */
export class PgEscalationSink implements EscalationSink {
  readonly name = "pg";
  constructor(
    private readonly sql: Sql,
    private readonly scope: string,
  ) {}

  /** Store an already-built ticket verbatim — the internal HTTP endpoint's PUT uses this: the
   *  sandboxed client (http-client.ts) runs the pure open()/idempotency check on ITS side (it
   *  knows the packet; the endpoint doesn't) and PUTs the resulting ticket as-is. */
  async put(t: EscalationTicket): Promise<void> {
    await this.sql(
      `insert into escalation_tickets (scope, id, data) values ($1, $2, $3)
       on conflict (scope, id) do update set data = excluded.data`,
      [this.scope, t.id, JSON.stringify(t)],
    );
  }

  async open(packet: EscalationPacket, now: string = new Date().toISOString()): Promise<EscalationTicket> {
    const existing = await this.get(ticketId(packet));
    if (existing) return existing; // idempotent: re-queuing the same escalation is a no-op
    const t = openTicket(packet, now);
    await this.put(t);
    return t;
  }
  async claim(id: string, reviewer: string, now: string = new Date().toISOString()): Promise<EscalationTicket> {
    const t = claimTicket(await this.require(id), reviewer, now);
    await this.put(t);
    return t;
  }
  async resolve(id: string, decisions: ReviewDecision[], now: string = new Date().toISOString()): Promise<EscalationTicket> {
    const t = resolveTicket(await this.require(id), decisions, now);
    await this.put(t);
    return t;
  }
  async get(id: string): Promise<EscalationTicket | null> {
    const rows = await this.sql(`select data from escalation_tickets where scope = $1 and id = $2`, [this.scope, id]);
    if (!rows[0]) return null;
    try {
      return JSON.parse(String(rows[0].data)) as EscalationTicket;
    } catch {
      return null;
    }
  }
  async list(state?: TicketState): Promise<EscalationTicket[]> {
    const rows = await this.sql(`select data from escalation_tickets where scope = $1`, [this.scope]);
    const out: EscalationTicket[] = [];
    for (const r of rows) {
      try {
        const t = JSON.parse(String(r.data)) as EscalationTicket;
        if (!state || t.state === state) out.push(t);
      } catch {
        /* skip an unreadable/partial row */
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async require(id: string): Promise<EscalationTicket> {
    const t = await this.get(id);
    if (!t) throw new Error(`no such ticket: ${id}`);
    return t;
  }
}
