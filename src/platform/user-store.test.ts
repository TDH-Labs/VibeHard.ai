import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureUserSchema, migrateLegacyUsersFile, PgUserStore, type UserRecord } from "./user-store.ts";
import { pgliteSql, type Sql } from "./pg-store.ts";

// Same pglite-per-test discipline as build-store.test.ts: real Postgres engine, no Docker/network.
const dbs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
});
async function freshSql(): Promise<Sql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  dbs.push(db);
  const sql = pgliteSql(db);
  await ensureUserSchema(sql);
  return sql;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "vibehard-userstore-"));
  dirs.push(d);
  return d;
}

const rec = (over: Partial<UserRecord> = {}): UserRecord => ({
  tenantId: "t-1",
  name: "Ada",
  hash: "clerk:user_123",
  ...over,
});

describe("PgUserStore", () => {
  test("unknown email → null", async () => {
    const store = new PgUserStore(await freshSql());
    expect(await store.get("nobody@example.com")).toBeNull();
  });

  test("put → get round-trips", async () => {
    const store = new PgUserStore(await freshSql());
    await store.put("ada@example.com", rec());
    expect(await store.get("ada@example.com")).toEqual(rec());
  });

  test("put twice overwrites (password reset / rebind), never duplicates", async () => {
    const store = new PgUserStore(await freshSql());
    await store.put("ada@example.com", rec({ hash: "old" }));
    await store.put("ada@example.com", rec({ hash: "new" }));
    expect(await store.get("ada@example.com")).toEqual(rec({ hash: "new" }));
  });

  test("accounts are keyed per email — one never shadows another", async () => {
    const store = new PgUserStore(await freshSql());
    await store.put("a@example.com", rec({ tenantId: "t-a" }));
    await store.put("b@example.com", rec({ tenantId: "t-b" }));
    expect((await store.get("a@example.com"))?.tenantId).toBe("t-a");
    expect((await store.get("b@example.com"))?.tenantId).toBe("t-b");
  });

  test("the actual regression: the email→tenant pointer survives a fresh store instance on the SAME Pg backend", async () => {
    const sql = await freshSql();
    const before = new PgUserStore(sql);
    await before.put("adam@example.com", rec({ tenantId: "t-original" }));

    // A brand-new store instance, same durable connection — the server restarting. Before this
    // module existed, this exact moment is where the mapping vanished and the auth seam minted
    // the same person a fresh tenant, orphaning every build keyed to t-original.
    const after = new PgUserStore(sql);
    expect((await after.get("adam@example.com"))?.tenantId).toBe("t-original");
  });
});

describe("migrateLegacyUsersFile", () => {
  test("imports entries Pg has never seen", async () => {
    const store = new PgUserStore(await freshSql());
    const dir = await freshDir();
    const p = join(dir, "users.json");
    await writeFile(p, JSON.stringify({ "ada@example.com": rec({ tenantId: "t-file" }) }));
    expect(await migrateLegacyUsersFile(store, p)).toBe(1);
    expect((await store.get("ada@example.com"))?.tenantId).toBe("t-file");
  });

  test("existing Pg rows win — a stale file never clobbers the durable mapping", async () => {
    const store = new PgUserStore(await freshSql());
    await store.put("ada@example.com", rec({ tenantId: "t-durable" }));
    const dir = await freshDir();
    const p = join(dir, "users.json");
    await writeFile(p, JSON.stringify({ "ada@example.com": rec({ tenantId: "t-stale" }) }));
    expect(await migrateLegacyUsersFile(store, p)).toBe(0);
    expect((await store.get("ada@example.com"))?.tenantId).toBe("t-durable");
  });

  test("missing or corrupt file imports nothing and never throws", async () => {
    const store = new PgUserStore(await freshSql());
    const dir = await freshDir();
    expect(await migrateLegacyUsersFile(store, join(dir, "absent.json"))).toBe(0);
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{not json");
    expect(await migrateLegacyUsersFile(store, bad)).toBe(0);
  });

  test("rows without a tenantId are skipped, the rest import", async () => {
    const store = new PgUserStore(await freshSql());
    const dir = await freshDir();
    const p = join(dir, "users.json");
    await writeFile(p, JSON.stringify({ "bad@example.com": { name: "x" }, "ok@example.com": rec() }));
    expect(await migrateLegacyUsersFile(store, p)).toBe(1);
    expect(await store.get("bad@example.com")).toBeNull();
    expect(await store.get("ok@example.com")).toEqual(rec());
  });
});
