/**
 * BuildLogStore — durable, append-only live build log (docs/build-substrate/
 * {SPEC,PRD,ARCHITECTURE}.md, W2). Deliberately NOT the `tenantKv`/`PgBuildProgressStore`
 * blob-overwrite shape (one JSON blob per scope, full read-modify-write on every append) —
 * that shape is correct for a handful of proactive messages and wrong for a build log that
 * can be thousands of lines: a plain per-line `insert` + a `seq`-ordered delta poll is O(1)
 * per write and lets a reconnecting client resume from its own last-seen position for free.
 *
 * `scope` is `${tenantId}:${app}`, matching the existing convention (e.g. the in-process
 * `orchestrators` map key in web/server.ts).
 */
import type { Sql } from "../platform/pg-store.ts";

export interface BuildLogLine {
  seq: number;
  line: string;
  at: string; // ISO 8601 — stored as `text`, not `timestamptz` (matches the rest of this
  //             codebase's convention: pg-store.ts's `tenants.created_at` is `text` too, to
  //             avoid postgres.js/pglite returning timestamps in different shapes).
}

export interface BuildLogStore {
  /** Append one line. O(1) — a plain insert, no read-modify-write. */
  append(scope: string, line: string): Promise<void>;
  /** Lines after `afterSeq`, oldest first, capped at `limit`. `afterSeq: 0` gets everything
   *  from the start — the shape a client on first connect (not reconnect) wants. */
  since(scope: string, afterSeq: number, limit?: number): Promise<BuildLogLine[]>;
  /** Retention: drop all but the most recent `keepLast` lines for `scope` (matches the
   *  `.slice(-50)`/`.slice(-200)` discipline already used elsewhere in this codebase). */
  prune(scope: string, keepLast: number): Promise<void>;
}

/** Idempotent — safe to call on every boot, alongside the other ensure*Schema functions
 *  (wired into db.ts's ensureAllSchema). */
export async function ensureBuildLogSchema(sql: Sql): Promise<void> {
  await sql(
    `create table if not exists build_log_lines (
       scope text not null,
       seq bigserial,
       line text not null,
       at text not null,
       primary key (scope, seq)
     )`,
  );
}

export class PgBuildLogStore implements BuildLogStore {
  constructor(private readonly sql: Sql) {}

  async append(scope: string, line: string): Promise<void> {
    await this.sql(`insert into build_log_lines (scope, line, at) values ($1, $2, $3)`, [scope, line, new Date().toISOString()]);
  }

  async since(scope: string, afterSeq: number, limit = 500): Promise<BuildLogLine[]> {
    const rows = await this.sql(`select seq, line, at from build_log_lines where scope = $1 and seq > $2 order by seq asc limit $3`, [
      scope,
      afterSeq,
      limit,
    ]);
    return rows.map((r) => ({ seq: Number(r.seq), line: String(r.line), at: String(r.at) }));
  }

  async prune(scope: string, keepLast: number): Promise<void> {
    await this.sql(
      `delete from build_log_lines where scope = $1 and seq not in (
         select seq from build_log_lines where scope = $1 order by seq desc limit $2
       )`,
      [scope, keepLast],
    );
  }
}

/** In-memory fake — same ordering/pagination contract, no database needed in tests. */
export class InMemoryBuildLogStore implements BuildLogStore {
  private readonly rows = new Map<string, BuildLogLine[]>();
  private nextSeq = 1;

  async append(scope: string, line: string): Promise<void> {
    const list = this.rows.get(scope) ?? [];
    list.push({ seq: this.nextSeq++, line, at: new Date().toISOString() });
    this.rows.set(scope, list);
  }

  async since(scope: string, afterSeq: number, limit = 500): Promise<BuildLogLine[]> {
    return (this.rows.get(scope) ?? []).filter((r) => r.seq > afterSeq).slice(0, limit);
  }

  async prune(scope: string, keepLast: number): Promise<void> {
    const list = this.rows.get(scope) ?? [];
    if (list.length > keepLast) this.rows.set(scope, list.slice(list.length - keepLast));
  }
}
