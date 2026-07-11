import { afterEach, describe, expect, test } from "bun:test";
import { ensureBuildLogSchema, InMemoryBuildLogStore, PgBuildLogStore, type BuildLogStore } from "./build-log-store.ts";
import { pgliteSql, type Sql } from "../platform/pg-store.ts";

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
  await ensureBuildLogSchema(sql);
  return sql;
}

/** Runs the SAME contract against both implementations — the fake must behave identically
 *  to the real store, or the fake is worthless for testing anything that depends on it. */
function contractTests(name: string, makeStore: () => Promise<BuildLogStore>): void {
  describe(`BuildLogStore contract — ${name}`, () => {
    test("append then since(0) returns lines in insertion order with monotonic seq", async () => {
      const store = await makeStore();
      await store.append("t1:app", "line one");
      await store.append("t1:app", "line two");
      await store.append("t1:app", "line three");
      const all = await store.since("t1:app", 0);
      expect(all.map((r) => r.line)).toEqual(["line one", "line two", "line three"]);
      expect(all[0]!.seq).toBeLessThan(all[1]!.seq);
      expect(all[1]!.seq).toBeLessThan(all[2]!.seq);
    });

    test("since(afterSeq) returns only NEW lines — the reconnect-replay contract (AC3.1)", async () => {
      const store = await makeStore();
      await store.append("t2:app", "a");
      await store.append("t2:app", "b");
      const first = await store.since("t2:app", 0);
      const lastSeq = first[first.length - 1]!.seq;

      await store.append("t2:app", "c");
      await store.append("t2:app", "d");
      const resumed = await store.since("t2:app", lastSeq);

      expect(resumed.map((r) => r.line)).toEqual(["c", "d"]);
    });

    test("different scopes never leak into each other", async () => {
      const store = await makeStore();
      await store.append("tenant-x:app", "x's line");
      await store.append("tenant-y:app", "y's line");
      expect((await store.since("tenant-x:app", 0)).map((r) => r.line)).toEqual(["x's line"]);
      expect((await store.since("tenant-y:app", 0)).map((r) => r.line)).toEqual(["y's line"]);
    });

    test("since respects a limit", async () => {
      const store = await makeStore();
      for (let i = 0; i < 10; i++) await store.append("t3:app", `line ${i}`);
      const page = await store.since("t3:app", 0, 3);
      expect(page).toHaveLength(3);
      expect(page.map((r) => r.line)).toEqual(["line 0", "line 1", "line 2"]);
    });

    test("prune keeps only the most recent N lines for that scope", async () => {
      const store = await makeStore();
      for (let i = 0; i < 5; i++) await store.append("t4:app", `line ${i}`);
      await store.prune("t4:app", 2);
      const remaining = await store.since("t4:app", 0);
      expect(remaining.map((r) => r.line)).toEqual(["line 3", "line 4"]);
    });

    test("prune on one scope doesn't touch another scope's lines", async () => {
      const store = await makeStore();
      await store.append("t5a:app", "keep me too");
      for (let i = 0; i < 5; i++) await store.append("t5b:app", `line ${i}`);
      await store.prune("t5b:app", 1);
      expect((await store.since("t5a:app", 0)).map((r) => r.line)).toEqual(["keep me too"]);
    });

    test("an empty scope (never appended to) returns an empty list, not an error", async () => {
      const store = await makeStore();
      expect(await store.since("never-touched:app", 0)).toEqual([]);
    });
  });
}

contractTests("InMemoryBuildLogStore (fake)", async () => new InMemoryBuildLogStore());
contractTests("PgBuildLogStore (real pglite)", async () => new PgBuildLogStore(await freshSql()));
