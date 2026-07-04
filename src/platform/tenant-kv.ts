/**
 * Durable per-tenant key/value state (EPIC #33, final sweep 2026-07-03): the last pieces of
 * tenant state that lived only in local files under ~/.vibehard/tenants/<id>/ — the encrypted
 * BYO LLM key (llm-key.enc), the integrations keychain (integrations.json: Stripe/Supabase/…
 * values, each separately encrypted), and the orchestrator chat inbox. Same failure mode the
 * build store and the identity map already fixed: no volume on the Fly machines, so every
 * deploy wiped them — a customer's saved keys silently vanished on the next release.
 *
 * This store holds OPAQUE strings. Secret values arrive already encrypted (web/server.ts's
 * AES-256-GCM helpers under VIBEHARD_SECRETS_KEY) — plaintext secrets never touch the table,
 * same posture as PgSecretsStore's sealed blobs. Non-secret values (the inbox JSON) are stored
 * as-is. One generic (scope, k) → data table instead of three bespoke ones, since every use is
 * the same shape and the callers own their own serialization.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "./pg-store.ts";

export interface TenantKvStore {
  get(tenantId: string, key: string): Promise<string | null>;
  put(tenantId: string, key: string, value: string): Promise<void>;
  /** every entry whose key starts with `prefix`, as { keyWithoutPrefix: value } */
  list(tenantId: string, prefix: string): Promise<Record<string, string>>;
}

/** Idempotent — called on every boot alongside the other ensure*Schema functions from db.ts. */
export async function ensureTenantKvSchema(sql: Sql): Promise<void> {
  await sql(`create table if not exists tenant_kv (scope text not null, k text not null, data text not null, primary key (scope, k))`);
}

export class PgTenantKvStore implements TenantKvStore {
  constructor(private readonly sql: Sql) {}

  async get(tenantId: string, key: string): Promise<string | null> {
    const rows = await this.sql(`select data from tenant_kv where scope = $1 and k = $2`, [tenantId, key]);
    return rows[0] ? String(rows[0].data) : null;
  }

  async put(tenantId: string, key: string, value: string): Promise<void> {
    await this.sql(
      `insert into tenant_kv (scope, k, data) values ($1, $2, $3)
       on conflict (scope, k) do update set data = excluded.data`,
      [tenantId, key, value],
    );
  }

  async list(tenantId: string, prefix: string): Promise<Record<string, string>> {
    const rows = await this.sql(`select k, data from tenant_kv where scope = $1 and k like $2`, [tenantId, `${prefix}%`]);
    const out: Record<string, string> = {};
    for (const r of rows) out[String(r.k).slice(prefix.length)] = String(r.data);
    return out;
  }
}

/**
 * One-time, best-effort import of the legacy per-tenant files into the durable store. Existing
 * Pg rows always win, so a stale disk can never clobber durable state. Ciphertext is imported
 * verbatim (same VIBEHARD_SECRETS_KEY decrypts it either way). Returns how many entries were
 * imported. Never throws.
 */
export async function migrateLegacyTenantFiles(store: TenantKvStore, vibehardRoot: string): Promise<number> {
  const tenantsDir = join(vibehardRoot, "tenants");
  if (!existsSync(tenantsDir)) return 0;
  let imported = 0;
  const importIfAbsent = async (tenant: string, key: string, value: string) => {
    if (await store.get(tenant, key)) return;
    await store.put(tenant, key, value);
    imported++;
  };
  for (const tenant of readdirSync(tenantsDir)) {
    try {
      const dir = join(tenantsDir, tenant);
      const keyFile = join(dir, "llm-key.enc");
      if (existsSync(keyFile)) await importIfAbsent(tenant, "llm-key", readFileSync(keyFile, "utf8"));
      const intFile = join(dir, "integrations.json");
      if (existsSync(intFile)) {
        const enc = JSON.parse(readFileSync(intFile, "utf8")) as Record<string, string>;
        for (const [k, v] of Object.entries(enc)) {
          if (typeof v === "string") await importIfAbsent(tenant, `integration:${k}`, v);
        }
      }
      const appsDir = join(dir, "apps");
      if (existsSync(appsDir)) {
        for (const app of readdirSync(appsDir)) {
          const inboxFile = join(appsDir, app, ".vibehard", "orchestrator-inbox.json");
          if (existsSync(inboxFile)) await importIfAbsent(tenant, `inbox:${app}`, readFileSync(inboxFile, "utf8"));
        }
      }
    } catch {
      /* skip a tenant we can't read, keep importing the rest */
    }
  }
  return imported;
}
