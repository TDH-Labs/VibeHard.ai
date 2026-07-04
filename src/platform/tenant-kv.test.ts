import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTenantKvSchema, migrateLegacyTenantFiles, PgTenantKvStore } from "./tenant-kv.ts";
import { pgliteSql, type Sql } from "./pg-store.ts";

// Same pglite-per-test discipline as build-store/user-store: real Postgres engine, no Docker.
const dbs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
});
async function freshSql(): Promise<Sql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  dbs.push(db);
  const sql = pgliteSql(db);
  await ensureTenantKvSchema(sql);
  return sql;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function freshRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "vibehard-tenantkv-"));
  dirs.push(d);
  return d;
}

describe("PgTenantKvStore", () => {
  test("unknown key → null", async () => {
    const store = new PgTenantKvStore(await freshSql());
    expect(await store.get("t-1", "llm-key")).toBeNull();
  });

  test("put → get round-trips an opaque value", async () => {
    const store = new PgTenantKvStore(await freshSql());
    await store.put("t-1", "llm-key", "ciphertext-blob");
    expect(await store.get("t-1", "llm-key")).toBe("ciphertext-blob");
  });

  test("put twice overwrites (key replacement), never duplicates", async () => {
    const store = new PgTenantKvStore(await freshSql());
    await store.put("t-1", "llm-key", "old");
    await store.put("t-1", "llm-key", "new");
    expect(await store.get("t-1", "llm-key")).toBe("new");
  });

  test("entries are tenant-scoped — one tenant never reads another's", async () => {
    const store = new PgTenantKvStore(await freshSql());
    await store.put("t-1", "llm-key", "mine");
    await store.put("t-2", "llm-key", "theirs");
    expect(await store.get("t-1", "llm-key")).toBe("mine");
    expect(await store.get("t-2", "llm-key")).toBe("theirs");
  });

  test("list returns prefix-stripped entries for exactly that tenant and prefix", async () => {
    const store = new PgTenantKvStore(await freshSql());
    await store.put("t-1", "integration:STRIPE_SECRET_KEY", "enc-a");
    await store.put("t-1", "integration:SUPABASE_URL", "enc-b");
    await store.put("t-1", "llm-key", "enc-c"); // different prefix — excluded
    await store.put("t-2", "integration:STRIPE_SECRET_KEY", "enc-other"); // different tenant — excluded
    expect(await store.list("t-1", "integration:")).toEqual({ STRIPE_SECRET_KEY: "enc-a", SUPABASE_URL: "enc-b" });
  });

  test("the regression this closes: entries survive a fresh store instance on the SAME Pg backend", async () => {
    const sql = await freshSql();
    await new PgTenantKvStore(sql).put("t-1", "integration:STRIPE_SECRET_KEY", "enc-token");
    // New instance, same durable connection — the server restarting. As local files these were
    // wiped every deploy: a customer's saved keys silently vanished on the next release.
    expect(await new PgTenantKvStore(sql).get("t-1", "integration:STRIPE_SECRET_KEY")).toBe("enc-token");
  });
});

describe("migrateLegacyTenantFiles", () => {
  async function legacyLayout(root: string): Promise<void> {
    const t = join(root, "tenants", "tenant-1");
    await mkdir(join(t, "apps", "app-x", ".vibehard"), { recursive: true });
    await writeFile(join(t, "llm-key.enc"), "key-ciphertext");
    await writeFile(join(t, "integrations.json"), JSON.stringify({ STRIPE_SECRET_KEY: "enc-1", SUPABASE_URL: "enc-2" }));
    await writeFile(join(t, "apps", "app-x", ".vibehard", "orchestrator-inbox.json"), JSON.stringify([{ at: 1, kind: "info", text: "hi" }]));
  }

  test("imports llm key, integrations, and inboxes from the legacy tree", async () => {
    const store = new PgTenantKvStore(await freshSql());
    const root = await freshRoot();
    await legacyLayout(root);
    expect(await migrateLegacyTenantFiles(store, root)).toBe(4);
    expect(await store.get("tenant-1", "llm-key")).toBe("key-ciphertext");
    expect(await store.list("tenant-1", "integration:")).toEqual({ STRIPE_SECRET_KEY: "enc-1", SUPABASE_URL: "enc-2" });
    expect(await store.get("tenant-1", "inbox:app-x")).toBe(JSON.stringify([{ at: 1, kind: "info", text: "hi" }]));
  });

  test("existing Pg rows win — a stale disk never clobbers durable state", async () => {
    const store = new PgTenantKvStore(await freshSql());
    await store.put("tenant-1", "llm-key", "durable-ciphertext");
    const root = await freshRoot();
    await legacyLayout(root);
    expect(await migrateLegacyTenantFiles(store, root)).toBe(3); // the key row is skipped
    expect(await store.get("tenant-1", "llm-key")).toBe("durable-ciphertext");
  });

  test("missing tenants dir imports nothing and never throws", async () => {
    const store = new PgTenantKvStore(await freshSql());
    expect(await migrateLegacyTenantFiles(store, await freshRoot())).toBe(0);
  });

  test("a corrupt integrations.json skips that tenant's remaining files but keeps other tenants", async () => {
    const store = new PgTenantKvStore(await freshSql());
    const root = await freshRoot();
    await legacyLayout(root); // tenant-1, fully valid
    const bad = join(root, "tenants", "tenant-2");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "integrations.json"), "{not json");
    expect(await migrateLegacyTenantFiles(store, root)).toBe(4); // tenant-1's four entries
    expect(await store.list("tenant-2", "integration:")).toEqual({});
  });
});
