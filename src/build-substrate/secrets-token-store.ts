/**
 * SecretsTokenStore — scoped, single-use, expiring tokens a BuildWorker exchanges for its build
 * env (docs/build-substrate/{SPEC,PRD,ARCHITECTURE}.md, W5b / SPEC decision #8). Minted by the
 * dispatcher at dispatch time, bound to exactly the env for THAT ONE dispatch — never handed to
 * `fly machine run --env`/`fly secrets set` equivalents, which would leave the value sitting in a
 * provider's own machine-config/audit surface. A worker calls back to an internal platform
 * endpoint with the token; the endpoint calls `consume()` and returns the env exactly once.
 *
 * Durable (Postgres) because the callback can land on a DIFFERENT machine than the one that
 * minted the token — the platform runs on multiple Fly machines behind one load balancer, the
 * same cross-machine requirement W7's ConfirmStore fix closed for orchestrator confirms.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../platform/pg-store.ts";

export interface SecretsTokenStore {
  /** Mint a token bound to `env`, valid for `ttlMs` (default 1h — a real build can run 45+ min,
   *  and the token is fetched once near the start of a dispatch, not re-used across retries). */
  mint(env: Record<string, string>, ttlMs?: number): Promise<string>;
  /** Redeem a token exactly once: returns the bound env on the FIRST valid call, `null` on every
   *  call after (already consumed, unknown, or expired) — never re-servable. */
  consume(token: string): Promise<Record<string, string> | null>;
}

const DEFAULT_TTL_MS = 60 * 60_000;

/** Idempotent — safe to call on every boot, alongside the other ensure*Schema functions. */
export async function ensureSecretsTokenSchema(sql: Sql): Promise<void> {
  await sql(
    `create table if not exists build_secrets_tokens (
       token text primary key,
       env text not null,
       expires_at text not null,
       consumed boolean not null default false
     )`,
  );
}

export class PgSecretsTokenStore implements SecretsTokenStore {
  constructor(private readonly sql: Sql) {}

  async mint(env: Record<string, string>, ttlMs = DEFAULT_TTL_MS): Promise<string> {
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await this.sql(`insert into build_secrets_tokens (token, env, expires_at, consumed) values ($1, $2, $3, false)`, [
      token,
      JSON.stringify(env),
      expiresAt,
    ]);
    return token;
  }

  async consume(token: string): Promise<Record<string, string> | null> {
    // Single UPDATE...RETURNING, guarded by `consumed = false` — atomic under Postgres MVCC, so
    // two concurrent callers with the same token can never both win: exactly one UPDATE matches
    // the row and returns it, the other matches zero rows and gets null. No separate read-then-
    // write race window (the exact shape of bug the checkpoint-push-then-destroy contract and
    // W7's durable ConfirmStore both exist to avoid elsewhere in this epic).
    const rows = await this.sql(
      `update build_secrets_tokens set consumed = true
       where token = $1 and consumed = false and expires_at > $2
       returning env`,
      [token, new Date().toISOString()],
    );
    if (!rows[0]) return null;
    try {
      return JSON.parse(String(rows[0].env)) as Record<string, string>;
    } catch {
      return null;
    }
  }
}

/** In-memory fake — same single-use/expiry contract, no database needed in tests. */
export class InMemorySecretsTokenStore implements SecretsTokenStore {
  private readonly rows = new Map<string, { env: Record<string, string>; expiresAt: number; consumed: boolean }>();

  async mint(env: Record<string, string>, ttlMs = DEFAULT_TTL_MS): Promise<string> {
    const token = randomUUID();
    this.rows.set(token, { env, expiresAt: Date.now() + ttlMs, consumed: false });
    return token;
  }

  async consume(token: string): Promise<Record<string, string> | null> {
    const row = this.rows.get(token);
    if (!row || row.consumed || row.expiresAt < Date.now()) return null;
    row.consumed = true;
    return row.env;
  }
}
