import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { PgTenantStore } from "./pg-store.ts";

const tmps: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
afterEach(async () => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ["DATABASE_URL", "VIBEHARD_DB_DIR"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
function useTempDbDir(): void {
  savedEnv.DATABASE_URL = process.env.DATABASE_URL;
  savedEnv.VIBEHARD_DB_DIR = process.env.VIBEHARD_DB_DIR;
  delete process.env.DATABASE_URL; // force embedded mode
  const dir = mkdtempSync(join(tmpdir(), "vibehard-db-"));
  tmps.push(dir);
  process.env.VIBEHARD_DB_DIR = dir;
}

describe("openDb — embedded mode (no DATABASE_URL)", () => {
  test("opens embedded, ensures schema, and a tenant round-trips", async () => {
    useTempDbDir();
    const db = await openDb();
    try {
      expect(db.mode).toBe("embedded");
      const store = new PgTenantStore(db.sql);
      await store.create({ id: "t1", name: "Acme", plan: "free", status: "active", createdAt: "2026-06-27T00:00:00.000Z" });
      expect((await store.get("t1"))?.name).toBe("Acme");
    } finally {
      await db.close();
    }
  });

  test("DURABILITY: data persists to disk across an open→close→reopen cycle", async () => {
    useTempDbDir();
    const db1 = await openDb();
    await new PgTenantStore(db1.sql).create({ id: "persist", name: "Keep", plan: "pro", status: "active", createdAt: "2026-06-27T00:00:00.000Z" });
    await db1.close();
    // reopen the SAME on-disk database — simulates a process/box restart
    const db2 = await openDb();
    try {
      expect((await new PgTenantStore(db2.sql).get("persist"))?.plan).toBe("pro");
    } finally {
      await db2.close();
    }
  });
});
