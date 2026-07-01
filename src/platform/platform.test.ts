import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Platform, type DeployFn, type PlatformOptions } from "./platform.ts";
import { FileTenantStore } from "./tenant-store.ts";
import { LocalBillingProvider } from "./billing.ts";
import type { UsageEvent } from "./types.ts";
import { FileRecordStore } from "../substrate/record.ts";
import { LocalEncryptedSecretsStore } from "../substrate/secrets.ts";
import type { DeploymentRecord } from "../substrate/types.ts";
import type { DeployOutcome } from "../substrate/orchestrator.ts";
import { ensurePlatformSchema, pgliteSql } from "./pg-store.ts";

const REC: DeploymentRecord = { app: "x", customerOrgRef: "o", projectRef: "r", hostRef: "h", url: "https://x", appliedMigrations: [], secretsRef: null, status: "live", updatedAt: "t" };
const OUTCOME: DeployOutcome = { live: true, url: "https://x", abortedAt: null, reason: "ok", record: REC };

/** A fake deploy that simulates the substrate writing a record into the tenant's state dir. */
const seedingDeploy: DeployFn = async (_ws, opts) => {
  const dir = join(opts!.stateDir!, "deployments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${opts!.app}.json`), JSON.stringify({ ...REC, app: opts!.app }));
  return OUTCOME;
};

function makePlatform(extra: Partial<PlatformOptions> = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), "dd-plat-"));
  let n = 0;
  const usage: Array<{ tenantId: string; event: UsageEvent }> = [];
  const billing = new LocalBillingProvider((tenantId, event) => usage.push({ tenantId, event }));
  const platform = new Platform({ baseDir, billing, now: () => "2026-01-01T00:00:00Z", newId: () => `t${++n}`, ...extra });
  return { platform, baseDir, usage, cleanup: () => rmSync(baseDir, { recursive: true, force: true }) };
}

describe("Platform — sign-up + lifecycle", () => {
  test("signUp creates an active tenant on the default (free) plan and persists it", async () => {
    const { platform, cleanup } = makePlatform();
    try {
      const t = await platform.signUp("Acme");
      expect(t).toEqual({ id: "t1", name: "Acme", plan: "free", status: "active", createdAt: "2026-01-01T00:00:00Z" });
      expect(await platform.getTenant("t1")).toEqual(t);
      expect((await platform.listTenants()).map((x) => x.id)).toEqual(["t1"]);
    } finally {
      cleanup();
    }
  });

  test("suspend / resume / setPlan mutate the tenant; unknown id throws", async () => {
    const { platform, cleanup } = makePlatform();
    try {
      await platform.signUp("Acme");
      expect((await platform.suspend("t1")).status).toBe("suspended");
      expect((await platform.resume("t1")).status).toBe("active");
      expect((await platform.setPlan("t1", "pro")).plan).toBe("pro");
      await expect(platform.suspend("ghost")).rejects.toThrow(/unknown tenant/);
    } finally {
      cleanup();
    }
  });
});

describe("Platform — quota enforcement", () => {
  test("free plan allows 1 project: a 2nd NEW app is blocked, a redeploy of an existing app is not", async () => {
    const { platform, cleanup } = makePlatform({ deploy: seedingDeploy });
    try {
      await platform.signUp("Acme"); // t1, free → maxProjects 1
      await platform.deployForTenant("t1", "/ws/app-a", { app: "app-a" }); // ok (0 → 1)
      expect(await platform.projectCount("t1")).toBe(1);
      await expect(platform.deployForTenant("t1", "/ws/app-b", { app: "app-b" })).rejects.toThrow(/quota exceeded/);
      await platform.deployForTenant("t1", "/ws/app-a", { app: "app-a" }); // redeploy of existing → allowed
      expect(await platform.projectCount("t1")).toBe(1); // still 1 (redeploy didn't add)
    } finally {
      cleanup();
    }
  });

  test("a failed deploy does NOT occupy a quota slot (transient failures don't block a free-tier tenant)", async () => {
    const { platform, cleanup } = makePlatform({ deploy: seedingDeploy });
    try {
      await platform.signUp("Acme"); // free → maxProjects 1
      const dir = join(platform.stateDir("t1"), "deployments");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "broken.json"), JSON.stringify({ ...REC, app: "broken", status: "failed" }));
      expect(await platform.projectCount("t1")).toBe(0); // the failed record is not counted
      await platform.deployForTenant("t1", "/ws/good", { app: "good" }); // still allowed despite the failed one
      expect(await platform.projectCount("t1")).toBe(1); // only the live one counts
    } finally {
      cleanup();
    }
  });

  test("upgrading the plan raises the quota", async () => {
    const { platform, cleanup } = makePlatform({ deploy: seedingDeploy });
    try {
      await platform.signUp("Acme"); // free → 1
      await platform.deployForTenant("t1", "/ws/a", { app: "a" });
      await expect(platform.deployForTenant("t1", "/ws/b", { app: "b" })).rejects.toThrow(/quota/);
      await platform.setPlan("t1", "starter"); // 5
      await platform.deployForTenant("t1", "/ws/b", { app: "b" }); // now allowed
      expect(await platform.projectCount("t1")).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("a suspended or unknown tenant cannot deploy (fail closed)", async () => {
    const { platform, cleanup } = makePlatform({ deploy: seedingDeploy });
    try {
      await platform.signUp("Acme");
      await platform.suspend("t1");
      await expect(platform.deployForTenant("t1", "/ws/a", { app: "a" })).rejects.toThrow(/suspended/);
      await expect(platform.deployForTenant("ghost", "/ws/a", { app: "a" })).rejects.toThrow(/unknown tenant/);
    } finally {
      cleanup();
    }
  });
});

describe("Platform — isolation + delegation", () => {
  test("tenants are isolated: one cannot see another's deployment records or secrets", async () => {
    const { platform, cleanup } = makePlatform();
    try {
      const a = await platform.signUp("A");
      const b = await platform.signUp("B");
      // records
      const recA = new FileRecordStore(join(platform.stateDir(a.id), "deployments"));
      const recB = new FileRecordStore(join(platform.stateDir(b.id), "deployments"));
      recA.put({ ...REC, app: "notes" });
      expect(recA.get("notes")).not.toBeNull();
      expect(recB.get("notes")).toBeNull(); // B's store cannot reach A's app
      // secrets
      const secA = new LocalEncryptedSecretsStore(join(platform.stateDir(a.id), "secrets"), "test-key");
      const secB = new LocalEncryptedSecretsStore(join(platform.stateDir(b.id), "secrets"), "test-key");
      await secA.put("notes", { url: "u", anonKey: "an", serviceKey: "s" });
      expect(await secA.get("notes")).not.toBeNull();
      expect(await secB.get("notes")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("build runs a queued job through the runner and records the outcome (incl. failures)", async () => {
    const { platform, cleanup } = makePlatform();
    try {
      await platform.signUp("Acme"); // t1
      const ok = await platform.build("t1", "myapp", { run: async () => ({ ok: true }) });
      expect(ok.status).toBe("succeeded");
      expect(ok.app).toBe("myapp");
      const bad = await platform.build("t1", "myapp", { run: async () => ({ ok: false, error: "gate blocked" }) });
      expect(bad.status).toBe("failed");
      expect(bad.error).toBe("gate blocked");
      const threw = await platform.build("t1", "myapp", { run: async () => { throw new Error("sandbox died"); } });
      expect(threw.status).toBe("failed"); // a thrown runner becomes a failed job, not an exception
      expect(threw.error).toBe("sandbox died");
      expect(platform.listBuilds("t1").length).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("build-rate quota: the free plan allows N builds/day, then blocks (fail closed)", async () => {
    const { platform, cleanup } = makePlatform();
    try {
      await platform.signUp("Acme"); // free → maxBuildsPerDay 10
      for (let i = 0; i < 10; i++) await platform.submitBuild("t1", "app");
      await expect(platform.submitBuild("t1", "app")).rejects.toThrow(/build rate limit/);
      expect(platform.usageCountSince("t1", "build", "2025-01-01T00:00:00Z")).toBe(10);
      await platform.suspend("t1");
      await expect(platform.submitBuild("t1", "app")).rejects.toThrow(/suspended/);
    } finally {
      cleanup();
    }
  });

  test("deployForTenant deploys into the tenant's OWN state dir, derives the app name, and meters usage", async () => {
    let captured: { app?: string; stateDir?: string; managed?: boolean } | undefined;
    const deploy: DeployFn = async (_ws, opts) => {
      captured = { app: opts?.app, stateDir: opts?.stateDir, managed: opts?.managed };
      return OUTCOME;
    };
    const { platform, usage, cleanup } = makePlatform({ deploy });
    try {
      const t = await platform.signUp("Acme");
      await platform.deployForTenant(t.id, "/work/my-app");
      expect(captured?.app).toBe("my-app"); // derived from the path basename
      expect(captured?.stateDir).toBe(platform.stateDir(t.id)); // the tenant's isolated dir
      expect(captured?.managed).toBe(true); // FORCED: tenant apps always get their own provisioned project
      expect(usage).toContainEqual({ tenantId: "t1", event: { kind: "deploy", app: "my-app", at: "2026-01-01T00:00:00Z" } }); // pushed to billing seam
      expect(platform.usage("t1")).toEqual([{ kind: "deploy", app: "my-app", at: "2026-01-01T00:00:00Z" }]); // …AND persisted to the durable ledger
    } finally {
      cleanup();
    }
  });
});

describe("Platform.open — durable tenant store", () => {
  // Embedded mode (no DATABASE_URL): tenant records persist to disk, the same engine prod uses.
  const saved: Record<string, string | undefined> = {};
  function useTempDb(): string {
    saved.DATABASE_URL = process.env.DATABASE_URL;
    saved.VIBEHARD_DB_DIR = process.env.VIBEHARD_DB_DIR;
    delete process.env.DATABASE_URL; // force embedded mode (no external Postgres in tests)
    const dir = mkdtempSync(join(tmpdir(), "dd-plat-db-"));
    process.env.VIBEHARD_DB_DIR = dir;
    return dir;
  }
  function restoreEnv(): void {
    for (const k of ["DATABASE_URL", "VIBEHARD_DB_DIR"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  test("signUp persists to the durable DB and survives a reopen (restart simulation)", async () => {
    const dir = useTempDb();
    try {
      const a = await Platform.open({ baseDir: dir });
      const t = await a.platform.signUp("Acme");
      expect(t.status).toBe("active");
      await a.db.close();
      // reopen the SAME on-disk DB — simulates the cloud box restarting/redeploying
      const b = await Platform.open({ baseDir: dir });
      try {
        expect((await b.platform.getTenant(t.id))?.name).toBe("Acme");
        expect((await b.platform.listTenants()).map((x) => x.id)).toEqual([t.id]);
      } finally {
        await b.db.close();
      }
    } finally {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicitly-supplied tenants store still wins over the durable default", async () => {
    const dir = useTempDb();
    try {
      const tenants = new FileTenantStore(join(dir, "explicit"));
      const { platform, db } = await Platform.open({ baseDir: dir, tenants });
      try {
        await platform.signUp("Beta");
        // it went to the injected file store, not the PG default
        expect((await tenants.list()).map((t) => t.name)).toEqual(["Beta"]);
      } finally {
        await db.close();
      }
    } finally {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Platform — constructor `sql` seam (EPIC #33a)", () => {
  test("a Platform constructed with an injected Sql signs up a tenant to Postgres and reads it back", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    try {
      const sql = pgliteSql(db);
      await ensurePlatformSchema(sql);
      const { platform, cleanup } = makePlatform({ sql });
      try {
        const t = await platform.signUp("Acme");
        expect((await platform.getTenant(t.id))?.name).toBe("Acme");
      } finally {
        cleanup();
      }
    } finally {
      await db.close();
    }
  });
});
