import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureBuildSchema,
  FileBuildProgressStore,
  PgBuildProgressStore,
  type ActiveBuild,
  type BuildProgressStore,
  type BuildRecord,
} from "./build-store.ts";
import { pgliteSql, type Sql } from "./pg-store.ts";

// Same pglite-per-test discipline as pg-store.test.ts: real Postgres engine, no Docker/network.
const dbs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
});
async function freshSql(): Promise<Sql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  dbs.push(db);
  const sql = pgliteSql(db);
  await ensureBuildSchema(sql);
  return sql;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "vibehard-buildstore-"));
  dirs.push(d);
  return d;
}

const active = (over: Partial<ActiveBuild> = {}): ActiveBuild => ({
  app: "app-1",
  prompt: "a tutoring booking app",
  status: "running",
  ...over,
});
const record = (over: Partial<BuildRecord> = {}): BuildRecord => ({
  app: "app-1",
  prompt: "a tutoring booking app",
  status: "running",
  at: 1000,
  ...over,
});

// Runs the SAME contract test suite against both backends — the whole point of the seam is that
// callers can't tell which one they're talking to.
function contractTests(name: string, makeStore: () => Promise<BuildProgressStore>) {
  describe(`${name} — BuildProgressStore contract`, () => {
    test("no active build → null", async () => {
      const store = await makeStore();
      expect(await store.getActive("t-1")).toBeNull();
    });

    test("setActive → getActive round-trips", async () => {
      const store = await makeStore();
      await store.setActive("t-1", active());
      expect(await store.getActive("t-1")).toEqual(active());
    });

    test("setActive twice overwrites, doesn't duplicate", async () => {
      const store = await makeStore();
      await store.setActive("t-1", active({ status: "running" }));
      await store.setActive("t-1", active({ status: "paused" }));
      expect(await store.getActive("t-1")).toEqual(active({ status: "paused" }));
    });

    test("active builds are tenant-scoped — one tenant never sees another's", async () => {
      const store = await makeStore();
      await store.setActive("t-1", active({ app: "app-a" }));
      await store.setActive("t-2", active({ app: "app-b" }));
      expect((await store.getActive("t-1"))?.app).toBe("app-a");
      expect((await store.getActive("t-2"))?.app).toBe("app-b");
    });

    test("listBuilds on an unknown tenant → empty array, not an error", async () => {
      const store = await makeStore();
      expect(await store.listBuilds("nobody")).toEqual([]);
    });

    test("appendBuild prepends (most recent first)", async () => {
      const store = await makeStore();
      await store.appendBuild("t-1", record({ app: "first", at: 1 }));
      await store.appendBuild("t-1", record({ app: "second", at: 2 }));
      expect((await store.listBuilds("t-1")).map((b) => b.app)).toEqual(["second", "first"]);
    });

    test("patchBuild updates the matching record's fields, leaves others untouched", async () => {
      const store = await makeStore();
      await store.appendBuild("t-1", record({ app: "app-1", status: "running" }));
      await store.appendBuild("t-1", record({ app: "app-2", status: "running" }));
      await store.patchBuild("t-1", "app-1", { status: "live", url: "https://app-1.example" });
      const list = await store.listBuilds("t-1");
      expect(list.find((b) => b.app === "app-1")).toEqual(
        record({ app: "app-1", status: "live", url: "https://app-1.example" }),
      );
      expect(list.find((b) => b.app === "app-2")?.status).toBe("running");
    });

    test("patchBuild on an unknown app is a no-op, not an error", async () => {
      const store = await makeStore();
      await store.appendBuild("t-1", record());
      await store.patchBuild("t-1", "ghost", { status: "error" });
      expect(await store.listBuilds("t-1")).toEqual([record()]);
    });

    test("listTenantIds surfaces every tenant with an active build — the boot-time sweep's job", async () => {
      const store = await makeStore();
      await store.setActive("t-1", active());
      await store.setActive("t-2", active());
      const ids = await store.listTenantIds();
      expect(ids.sort()).toEqual(["t-1", "t-2"]);
    });
  });
}

contractTests("FileBuildProgressStore", async () => new FileBuildProgressStore(await freshDir()));
contractTests("PgBuildProgressStore", async () => new PgBuildProgressStore(await freshSql()));

describe("the actual regression this closes", () => {
  test("a build marked 'running' survives a fresh store instance against the SAME Pg backend — the crash-recovery sweep depends on this", async () => {
    const sql = await freshSql();
    const writer = new PgBuildProgressStore(sql);
    await writer.setActive("t-1", active({ status: "running" }));
    await writer.appendBuild("t-1", record({ status: "running" }));

    // A brand-new store instance, same `sql` — simulates the server process restarting and
    // re-opening the SAME durable Postgres connection, the exact scenario that silently lost the
    // build tonight when it was file-only.
    const reader = new PgBuildProgressStore(sql);
    expect(await reader.getActive("t-1")).toEqual(active({ status: "running" }));
    expect(await reader.listBuilds("t-1")).toEqual([record({ status: "running" })]);
  });
});
