/**
 * Database connection for durable platform state (EPIC #33). One factory, two backends behind the
 * same `Sql` runner:
 *   - PRODUCTION (cloud): `DATABASE_URL` set → managed Postgres via postgres.js.
 *   - LOCAL/dev: no `DATABASE_URL` → embedded Postgres (pglite) persisted to disk
 *     (`VIBEHARD_DB_DIR`, default ~/.vibehard/db) — durable across restarts with NO external account.
 *
 * Schema is ensured on open (idempotent), so a fresh deploy or a fresh laptop just works.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { ensurePlatformSchema, ensureSubstrateSchema, pgliteSql, type Sql } from "./pg-store.ts";

export interface Db {
  sql: Sql;
  close: () => Promise<void>;
  mode: "postgres" | "embedded";
}

/** Adapt postgres.js (managed Postgres) to the `Sql` runner. `unsafe(query, params)` runs a
 *  parameterized statement and returns the rows. */
export function postgresSql(connectionString: string): { sql: Sql; close: () => Promise<void> } {
  const client = postgres(connectionString, { max: 10, idle_timeout: 20, prepare: false });
  const sql: Sql = async (query, params = []) => (await client.unsafe(query, params as never[])) as unknown as Record<string, unknown>[];
  return { sql, close: () => client.end({ timeout: 5 }) };
}

async function ensureAllSchema(sql: Sql): Promise<void> {
  await ensurePlatformSchema(sql);
  await ensureSubstrateSchema(sql);
}

/**
 * Open the durable database. Managed Postgres when `DATABASE_URL` is set (cloud), else embedded
 * disk-persisted Postgres (local). Ensures the schema before returning.
 */
export async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { sql, close } = postgresSql(url);
    await ensureAllSchema(sql);
    return { sql, close, mode: "postgres" };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = process.env.VIBEHARD_DB_DIR ?? join(homedir(), ".vibehard", "db");
  const db = new PGlite(dataDir); // persisted to disk → durable across restarts, no external service
  const sql = pgliteSql(db);
  await ensureAllSchema(sql);
  return { sql, close: () => db.close(), mode: "embedded" };
}
