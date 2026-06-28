import { afterEach, describe, expect, test } from "bun:test";
import { ensurePlatformSchema, pgliteSql, PgTenantStore, type Sql } from "./pg-store.ts";
import type { Tenant } from "./types.ts";

// Each test gets a fresh embedded Postgres (pglite) — same engine as prod Postgres, no Docker/network.
const dbs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
});
async function freshSql(): Promise<Sql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  dbs.push(db);
  const sql = pgliteSql(db);
  await ensurePlatformSchema(sql);
  return sql;
}

const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  id: "t-1",
  name: "Acme",
  plan: "free",
  status: "active",
  createdAt: "2026-06-27T00:00:00.000Z",
  ...over,
});

describe("PgTenantStore — durable tenant persistence", () => {
  test("create → get round-trips every field", async () => {
    const store = new PgTenantStore(await freshSql());
    await store.create(tenant());
    expect(await store.get("t-1")).toEqual(tenant());
  });

  test("get(unknown) → null", async () => {
    const store = new PgTenantStore(await freshSql());
    expect(await store.get("nope")).toBeNull();
  });

  test("list returns all, ordered by createdAt", async () => {
    const store = new PgTenantStore(await freshSql());
    await store.create(tenant({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }));
    await store.create(tenant({ id: "b", createdAt: "2026-02-01T00:00:00.000Z" }));
    expect((await store.list()).map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("update changes plan/status; id + createdAt immutable", async () => {
    const store = new PgTenantStore(await freshSql());
    await store.create(tenant());
    await store.update(tenant({ plan: "pro", status: "suspended" }));
    const got = await store.get("t-1");
    expect(got).toMatchObject({ plan: "pro", status: "suspended", createdAt: "2026-06-27T00:00:00.000Z" });
  });

  test("create is idempotent (conflict do nothing) — no duplicate, no throw", async () => {
    const store = new PgTenantStore(await freshSql());
    await store.create(tenant());
    await store.create(tenant({ name: "ignored-second-write" }));
    expect((await store.list()).length).toBe(1);
    expect((await store.get("t-1"))?.name).toBe("Acme");
  });

  test("DURABILITY: a fresh store over the SAME db sees prior writes (survives a 'restart')", async () => {
    const sql = await freshSql();
    await new PgTenantStore(sql).create(tenant({ id: "persist", plan: "starter" }));
    // simulate a process restart: a brand-new store instance over the same database
    const reopened = new PgTenantStore(sql);
    expect((await reopened.get("persist"))?.plan).toBe("starter");
  });
});
