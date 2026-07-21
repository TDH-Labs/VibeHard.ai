import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgliteSql, type Sql } from "../platform/pg-store.ts";
import { ensureFleetSchema, localFleetStore, PgFleetStore, FLEET_SEED, type Candidate, type Convention } from "./store.ts";

// Each test gets a fresh embedded Postgres (pglite) — same engine as prod Postgres, no Docker/network.
const dbs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
});
async function freshSql(seed: Convention[] = []): Promise<Sql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  dbs.push(db);
  const sql = pgliteSql(db);
  await ensureFleetSchema(sql, seed);
  return sql;
}

const convention = (over: Partial<Convention> = {}): Convention => ({
  id: "no-clerk",
  stack: "next-supabase",
  phase: "both",
  builds: 1,
  addresses: "rls:x",
  rule: "Use Supabase Auth.",
  ...over,
});
const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  key: "next-supabase::verify:x",
  stack: "next-supabase",
  signal: "verify:x",
  builds: 1,
  apps: [],
  resolutions: [],
  ...over,
});

describe("ensureFleetSchema — seeding", () => {
  test("seeds the conventions table from `seed` iff it's empty", async () => {
    const sql = await freshSql([convention({ id: "a" }), convention({ id: "b" })]);
    const store = new PgFleetStore(sql);
    expect((await store.getConventions()).map((c) => c.id).sort()).toEqual(["a", "b"]);
  });
  test("does NOT reseed a table that already has rows (idempotent boot, no duplication/overwrite)", async () => {
    const sql = await freshSql([convention({ id: "a" })]);
    await new PgFleetStore(sql).putConvention(convention({ id: "a", rule: "custom edit" }));
    await ensureFleetSchema(sql, [convention({ id: "a", rule: "seed version" })]); // simulate a second boot
    const got = (await new PgFleetStore(sql).getConventions()).find((c) => c.id === "a");
    expect(got?.rule).toBe("custom edit"); // the seed never clobbers a live edit
  });
});

describe("PgFleetStore — durable, global (no tenant scope), fixes the sandbox-durability defect", () => {
  test("getCandidate/putCandidate round-trip by key", async () => {
    const store = new PgFleetStore(await freshSql());
    expect(await store.getCandidate("next-supabase::verify:x")).toBeNull();
    await store.putCandidate(candidate({ builds: 2, apps: ["a", "b"] }));
    expect(await store.getCandidate("next-supabase::verify:x")).toEqual(candidate({ builds: 2, apps: ["a", "b"] }));
  });
  test("putCandidate upserts (second write wins) — atomic per-key, not a whole-list race", async () => {
    const store = new PgFleetStore(await freshSql());
    await store.putCandidate(candidate({ builds: 1 }));
    await store.putCandidate(candidate({ builds: 5 }));
    expect((await store.getCandidate("next-supabase::verify:x"))?.builds).toBe(5);
  });
  test("listCandidates returns every candidate across keys", async () => {
    const store = new PgFleetStore(await freshSql());
    await store.putCandidate(candidate({ key: "a", signal: "a" }));
    await store.putCandidate(candidate({ key: "b", signal: "b" }));
    expect((await store.listCandidates()).map((c) => c.signal).sort()).toEqual(["a", "b"]);
  });
  test("DURABILITY: a fresh store instance over the SAME db sees prior writes (survives a sandbox teardown)", async () => {
    const sql = await freshSql([convention({ id: "seeded" })]);
    await new PgFleetStore(sql).putCandidate(candidate());
    // simulate a brand-new process (a fresh E2B sandbox) reconnecting to the SAME Postgres
    const reopened = new PgFleetStore(sql);
    expect(await reopened.getCandidate("next-supabase::verify:x")).not.toBeNull();
    expect((await reopened.getConventions()).some((c) => c.id === "seeded")).toBe(true);
  });
  test("putConvention upserts by id", async () => {
    const store = new PgFleetStore(await freshSql());
    await store.putConvention(convention({ id: "new-one", builds: 1 }));
    await store.putConvention(convention({ id: "new-one", builds: 4 }));
    expect((await store.getConventions()).find((c) => c.id === "new-one")?.builds).toBe(4);
  });
});

describe("localFleetStore — unchanged pure-local/dev behavior (no platform behind the CLI at all)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "vibehard-fleet-store-"));
    dirs.push(d);
    return d;
  }

  test("seeds conventions.json on first read", async () => {
    const dir = tempDir();
    process.env.VIBEHARD_FLEET_DIR = dir;
    try {
      const store = localFleetStore(FLEET_SEED);
      const all = await store.getConventions();
      expect(all).toEqual(FLEET_SEED);
      expect(existsSync(join(dir, "conventions.json"))).toBe(true);
    } finally {
      delete process.env.VIBEHARD_FLEET_DIR;
    }
  });
  test("getCandidate/putCandidate round-trip via the local file", async () => {
    const dir = tempDir();
    process.env.VIBEHARD_FLEET_DIR = dir;
    try {
      const store = localFleetStore([]);
      await store.putCandidate(candidate({ builds: 3 }));
      expect((await store.getCandidate("next-supabase::verify:x"))?.builds).toBe(3);
    } finally {
      delete process.env.VIBEHARD_FLEET_DIR;
    }
  });
});
