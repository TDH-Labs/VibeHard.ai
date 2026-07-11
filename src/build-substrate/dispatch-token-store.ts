/**
 * DispatchTokenStore — a reusable (NOT single-use, unlike SecretsTokenStore), TTL-bound token
 * that resolves to the (tenantId, app) of one dispatch (docs/build-substrate/
 * {SPEC,PRD,ARCHITECTURE}.md, W5a/W6). A BuildWorker's checkpoint script calls
 * /api/internal/build-checkpoint-ping with this token once per autofix round to (a) refresh the
 * durable heartbeat (W6) and (b) learn whether the operator asked to stop (W5a) — both need the
 * SAME token resolved MANY times across a build's lifetime, which is why this is a separate
 * store from the single-use SecretsTokenStore rather than a reused field on it: `resolve()` is
 * read-only and idempotent, deliberately with none of `consume()`'s one-shot semantics.
 *
 * Lower sensitivity than the secrets token by design — resolving it only ever reveals which
 * (tenantId, app) a token belongs to, never a credential — so reusability here doesn't carry the
 * same risk single-use was chosen to bound for env-fetch (SPEC decision #8).
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../platform/pg-store.ts";

export interface DispatchTokenStore {
  mint(tenantId: string, app: string, ttlMs?: number): Promise<string>;
  /** Read-only, callable any number of times; null once expired or unknown. */
  resolve(token: string): Promise<{ tenantId: string; app: string } | null>;
}

const DEFAULT_TTL_MS = 60 * 60_000; // matches BuildWorker's own default dispatch timeout

export async function ensureDispatchTokenSchema(sql: Sql): Promise<void> {
  await sql(
    `create table if not exists build_dispatch_tokens (
       token text primary key,
       tenant_id text not null,
       app text not null,
       expires_at text not null
     )`,
  );
}

export class PgDispatchTokenStore implements DispatchTokenStore {
  constructor(private readonly sql: Sql) {}

  async mint(tenantId: string, app: string, ttlMs = DEFAULT_TTL_MS): Promise<string> {
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await this.sql(`insert into build_dispatch_tokens (token, tenant_id, app, expires_at) values ($1, $2, $3, $4)`, [
      token,
      tenantId,
      app,
      expiresAt,
    ]);
    return token;
  }

  async resolve(token: string): Promise<{ tenantId: string; app: string } | null> {
    const rows = await this.sql(`select tenant_id, app, expires_at from build_dispatch_tokens where token = $1`, [token]);
    const row = rows[0];
    if (!row) return null;
    if (new Date(String(row.expires_at)).getTime() < Date.now()) return null;
    return { tenantId: String(row.tenant_id), app: String(row.app) };
  }
}

/** In-memory fake — same resolve-many-times contract, no database needed in tests. */
export class InMemoryDispatchTokenStore implements DispatchTokenStore {
  private readonly rows = new Map<string, { tenantId: string; app: string; expiresAt: number }>();

  async mint(tenantId: string, app: string, ttlMs = DEFAULT_TTL_MS): Promise<string> {
    const token = randomUUID();
    this.rows.set(token, { tenantId, app, expiresAt: Date.now() + ttlMs });
    return token;
  }

  async resolve(token: string): Promise<{ tenantId: string; app: string } | null> {
    const row = this.rows.get(token);
    if (!row || row.expiresAt < Date.now()) return null;
    return { tenantId: row.tenantId, app: row.app };
  }
}
