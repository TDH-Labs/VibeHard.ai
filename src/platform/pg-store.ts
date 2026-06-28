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
import type { Tenant } from "./types.ts";

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
export class PgTenantStore {
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
