import { afterEach, describe, expect, test } from "bun:test";
import { authorizeRecordRequest, ensureDispatchTokenSchema, InMemoryDispatchTokenStore, PgDispatchTokenStore, type DispatchTokenStore } from "./dispatch-token-store.ts";
import { pgliteSql, type Sql } from "../platform/pg-store.ts";

const dbs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
});
async function freshSql(): Promise<Sql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  dbs.push(db);
  const sql = pgliteSql(db);
  await ensureDispatchTokenSchema(sql);
  return sql;
}

function contractTests(name: string, makeStore: () => Promise<DispatchTokenStore>): void {
  describe(`DispatchTokenStore contract — ${name}`, () => {
    test("mint then resolve returns the bound tenantId/app", async () => {
      const store = await makeStore();
      const token = await store.mint("tenant-1", "app-1");
      expect(await store.resolve(token)).toEqual({ tenantId: "tenant-1", app: "app-1" });
    });

    test("THE CONTRACT THIS CLOSES: resolve is NOT single-use — many calls all succeed", async () => {
      const store = await makeStore();
      const token = await store.mint("tenant-1", "app-1");
      for (let i = 0; i < 5; i++) {
        expect(await store.resolve(token)).toEqual({ tenantId: "tenant-1", app: "app-1" });
      }
    });

    test("an unknown token resolves to null", async () => {
      const store = await makeStore();
      expect(await store.resolve("never-minted")).toBeNull();
    });

    test("an expired token resolves to null", async () => {
      const store = await makeStore();
      const token = await store.mint("tenant-1", "app-1", -1);
      expect(await store.resolve(token)).toBeNull();
    });

    test("tokens for different dispatches never cross-resolve", async () => {
      const store = await makeStore();
      const t1 = await store.mint("tenant-1", "app-1");
      const t2 = await store.mint("tenant-2", "app-2");
      expect(await store.resolve(t1)).toEqual({ tenantId: "tenant-1", app: "app-1" });
      expect(await store.resolve(t2)).toEqual({ tenantId: "tenant-2", app: "app-2" });
    });
  });
}

contractTests("InMemoryDispatchTokenStore (fake)", async () => new InMemoryDispatchTokenStore());
contractTests("PgDispatchTokenStore (real pglite)", async () => new PgDispatchTokenStore(await freshSql()));

describe("authorizeRecordRequest — /api/internal/deployment-record's scope enforcement (2026-07-19)", () => {
  test("a resolved token requesting ITS OWN app → authorized, tenantId surfaced", () => {
    expect(authorizeRecordRequest({ tenantId: "t-1", app: "myapp" }, "myapp")).toEqual({ ok: true, tenantId: "t-1" });
  });

  test("a resolved token requesting a DIFFERENT app → refused (a stale/copy-pasted token must never touch another app's record)", () => {
    expect(authorizeRecordRequest({ tenantId: "t-1", app: "myapp" }, "someone-elses-app")).toEqual({ ok: false, status: 404 });
  });

  test("an unresolved (bad/expired) token → refused, same 404 the checkpoint-ping endpoint uses (never a 403 — that would confirm the app exists)", () => {
    expect(authorizeRecordRequest(null, "myapp")).toEqual({ ok: false, status: 404 });
  });

  test("no app named in the request at all → refused", () => {
    expect(authorizeRecordRequest({ tenantId: "t-1", app: "myapp" }, null)).toEqual({ ok: false, status: 404 });
  });
});
