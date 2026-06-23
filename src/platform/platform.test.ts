import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Platform, type DeployFn, type PlatformOptions } from "./platform.ts";
import { LocalBillingProvider } from "./billing.ts";
import type { UsageEvent } from "./types.ts";
import { FileRecordStore } from "../substrate/record.ts";
import { LocalEncryptedSecretsStore } from "../substrate/secrets.ts";
import type { DeploymentRecord } from "../substrate/types.ts";
import type { DeployOutcome } from "../substrate/orchestrator.ts";

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
  test("signUp creates an active tenant on the default (free) plan and persists it", () => {
    const { platform, cleanup } = makePlatform();
    try {
      const t = platform.signUp("Acme");
      expect(t).toEqual({ id: "t1", name: "Acme", plan: "free", status: "active", createdAt: "2026-01-01T00:00:00Z" });
      expect(platform.getTenant("t1")).toEqual(t);
      expect(platform.listTenants().map((x) => x.id)).toEqual(["t1"]);
    } finally {
      cleanup();
    }
  });

  test("suspend / resume / setPlan mutate the tenant; unknown id throws", () => {
    const { platform, cleanup } = makePlatform();
    try {
      platform.signUp("Acme");
      expect(platform.suspend("t1").status).toBe("suspended");
      expect(platform.resume("t1").status).toBe("active");
      expect(platform.setPlan("t1", "pro").plan).toBe("pro");
      expect(() => platform.suspend("ghost")).toThrow(/unknown tenant/);
    } finally {
      cleanup();
    }
  });
});

describe("Platform — quota enforcement", () => {
  test("free plan allows 1 project: a 2nd NEW app is blocked, a redeploy of an existing app is not", async () => {
    const { platform, cleanup } = makePlatform({ deploy: seedingDeploy });
    try {
      platform.signUp("Acme"); // t1, free → maxProjects 1
      await platform.deployForTenant("t1", "/ws/app-a", { app: "app-a" }); // ok (0 → 1)
      expect(platform.projectCount("t1")).toBe(1);
      await expect(platform.deployForTenant("t1", "/ws/app-b", { app: "app-b" })).rejects.toThrow(/quota exceeded/);
      await platform.deployForTenant("t1", "/ws/app-a", { app: "app-a" }); // redeploy of existing → allowed
      expect(platform.projectCount("t1")).toBe(1); // still 1 (redeploy didn't add)
    } finally {
      cleanup();
    }
  });

  test("upgrading the plan raises the quota", async () => {
    const { platform, cleanup } = makePlatform({ deploy: seedingDeploy });
    try {
      platform.signUp("Acme"); // free → 1
      await platform.deployForTenant("t1", "/ws/a", { app: "a" });
      await expect(platform.deployForTenant("t1", "/ws/b", { app: "b" })).rejects.toThrow(/quota/);
      platform.setPlan("t1", "starter"); // 5
      await platform.deployForTenant("t1", "/ws/b", { app: "b" }); // now allowed
      expect(platform.projectCount("t1")).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("a suspended or unknown tenant cannot deploy (fail closed)", async () => {
    const { platform, cleanup } = makePlatform({ deploy: seedingDeploy });
    try {
      platform.signUp("Acme");
      platform.suspend("t1");
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
      const a = platform.signUp("A");
      const b = platform.signUp("B");
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

  test("deployForTenant deploys into the tenant's OWN state dir, derives the app name, and meters usage", async () => {
    let captured: { app?: string; stateDir?: string } | undefined;
    const deploy: DeployFn = async (_ws, opts) => {
      captured = { app: opts?.app, stateDir: opts?.stateDir };
      return OUTCOME;
    };
    const { platform, usage, cleanup } = makePlatform({ deploy });
    try {
      const t = platform.signUp("Acme");
      await platform.deployForTenant(t.id, "/work/my-app");
      expect(captured?.app).toBe("my-app"); // derived from the path basename
      expect(captured?.stateDir).toBe(platform.stateDir(t.id)); // the tenant's isolated dir
      expect(usage).toContainEqual({ tenantId: "t1", event: { kind: "deploy", app: "my-app", at: "2026-01-01T00:00:00Z" } });
    } finally {
      cleanup();
    }
  });
});
