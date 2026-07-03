/**
 * Durable account-identity mapping (EPIC #33, closing the SECOND gap found 2026-07-03: after a
 * deploy restarted the machines, a signed-in Clerk user's builds vanished — the build records
 * were safely in Postgres (build-store.ts fixed that hours earlier), but the email → tenantId
 * pointer lived ONLY in a local users.json. The wipe made findTenantByEmail miss, so the auth
 * seam silently minted the SAME person a brand-new tenant, orphaning everything keyed to the
 * old one. Identity is the root pointer to all durable state; it has to be at least as durable
 * as the state it points to.
 *
 * Same shape as PgBuildProgressStore/PgRecordStore: a JSON blob per scope row (scope = email),
 * riding the one `sql` connection Platform.open() already provides. Table is named
 * `platform_users` (not `users`) to keep it unmistakably control-plane, never confusable with
 * any generated app's own users table.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Sql } from "./pg-store.ts";

/** One account: which tenant it owns, display name, and the credential marker —
 *  a Bun password hash, `oauth:<provider>`, or `clerk:<userId>`. */
export type UserRecord = { tenantId: string; name: string; hash: string };

export interface UserStore {
  get(email: string): Promise<UserRecord | null>;
  put(email: string, u: UserRecord): Promise<void>;
}

/** Control-plane account table. Idempotent — called on every boot alongside the other
 *  ensure*Schema functions from db.ts. */
export async function ensureUserSchema(sql: Sql): Promise<void> {
  await sql(`create table if not exists platform_users (scope text primary key, data text not null)`);
}

export class PgUserStore implements UserStore {
  constructor(private readonly sql: Sql) {}

  async get(email: string): Promise<UserRecord | null> {
    const rows = await this.sql(`select data from platform_users where scope = $1`, [email]);
    if (!rows[0]) return null;
    try {
      return JSON.parse(String(rows[0].data)) as UserRecord;
    } catch {
      return null;
    }
  }

  async put(email: string, u: UserRecord): Promise<void> {
    await this.sql(
      `insert into platform_users (scope, data) values ($1, $2)
       on conflict (scope) do update set data = excluded.data`,
      [email, JSON.stringify(u)],
    );
  }
}

/**
 * One-time, best-effort import of a legacy users.json (the pre-Pg local file) into the durable
 * store. Existing Pg rows always win — the file is only trusted for emails Pg has never seen,
 * so a machine with a stale file can't clobber the durable mapping. Returns how many were
 * imported. Never throws (a corrupt or missing file imports nothing).
 */
export async function migrateLegacyUsersFile(store: UserStore, usersJsonPath: string): Promise<number> {
  if (!existsSync(usersJsonPath)) return 0;
  let legacy: Record<string, UserRecord>;
  try {
    legacy = JSON.parse(readFileSync(usersJsonPath, "utf8")) as Record<string, UserRecord>;
  } catch {
    return 0;
  }
  let imported = 0;
  for (const [email, u] of Object.entries(legacy)) {
    try {
      if (!u || typeof u.tenantId !== "string") continue;
      if (await store.get(email)) continue; // durable mapping wins over the file
      await store.put(email, u);
      imported++;
    } catch {
      /* skip a bad row, keep importing the rest */
    }
  }
  return imported;
}
