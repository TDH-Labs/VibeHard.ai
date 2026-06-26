import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { destroy, provisionAndDeploy, type DeployInput, type SubstrateDeps } from "./orchestrator.ts";
import type { BackendProvider, BackendSecrets, HostProvider, RecordStore, SecretsStore } from "./types.ts";

const ts = "2026-06-22T00:00:00.000Z";
const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A workspace WITH the gate sentinel — the precondition the orchestrator checks. */
async function passingWorkspace(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "dd-sub-ws-"));
  tmps.push(d);
  mkdirSync(join(d, ".gate"), { recursive: true });
  writeFileSync(join(d, ".gate", "HARD_VERIFY_PASS"), "ok");
  return d;
}

function memRecords(): RecordStore {
  const m = new Map<string, ReturnType<RecordStore["get"]>>();
  return {
    get: (a) => m.get(a) ?? null,
    put: (r) => void m.set(r.app, structuredClone(r)),
    remove: (a) => void m.delete(a),
  };
}
function memSecrets(): SecretsStore & { has: (a: string) => boolean } {
  const m = new Map<string, BackendSecrets>();
  return {
    name: "mem",
    put: async (a, s) => {
      m.set(a, s);
      return `ref-${a}`;
    },
    get: async (a) => m.get(a) ?? null,
    remove: async (a) => void m.delete(a),
    has: (a) => m.has(a),
  };
}
function fakeBackend(over: Partial<BackendProvider> = {}): BackendProvider {
  return {
    name: "fake-backend",
    ensureProject: async (rec) => ({ handle: { projectRef: rec.projectRef ?? "proj-1" }, secrets: { url: "https://x.supabase.co", anonKey: "ANON", serviceKey: "SERVICE" } }),
    applyMigrations: async (_h, migs, applied) => ({ ok: true, appliedNow: migs.map((m) => m.id).filter((id) => !applied.includes(id)) }),
    verifyLiveRls: async () => ({ enforced: true, leakedTables: [], inconclusive: [] }),
    configureAuth: async () => {},
    deleteProject: async () => {},
    ...over,
  };
}
function fakeHost(over: Partial<HostProvider> = {}): HostProvider & { lastEnv: Record<string, string> | null } {
  const h: HostProvider & { lastEnv: Record<string, string> | null } = {
    name: "fake-host",
    lastEnv: null,
    deploy: async (_ws, env, hostRef) => {
      h.lastEnv = env;
      return { url: "https://app.example.com", hostRef: hostRef ?? "host-1" };
    },
    teardown: async () => {},
    ...over,
  };
  return h;
}
function deps(over: Partial<SubstrateDeps> = {}): SubstrateDeps {
  return { backend: fakeBackend(), host: fakeHost(), secrets: memSecrets(), records: memRecords(), now: () => ts, ...over };
}
async function input(over: Partial<DeployInput> = {}): Promise<DeployInput> {
  return { app: "myapp", org: { orgRef: "org-1" }, workspacePath: await passingWorkspace(), migrations: [{ id: "0001", sql: "create table t" }], rlsTables: ["t"], ...over };
}

describe("provisionAndDeploy — the deterministic sequence", () => {
  test("happy path → live, record marked live, migration recorded, secrets stored", async () => {
    const r = await provisionAndDeploy(await input(), deps());
    expect(r).toMatchObject({ live: true, url: "https://app.example.com", abortedAt: null });
    expect(r.record).toMatchObject({ status: "live", projectRef: "proj-1", hostRef: "host-1", appliedMigrations: ["0001"], secretsRef: "ref-myapp" });
  });

  test("the service-role key NEVER goes into the host env — only url + anon key", async () => {
    const host = fakeHost();
    await provisionAndDeploy(await input(), deps({ host }));
    // every value is url or anon (under canonical + framework-public names); never the service key
    expect(Object.values(host.lastEnv!).every((v) => v === "https://x.supabase.co" || v === "ANON")).toBe(true);
    expect(host.lastEnv!.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("ANON");
    expect(JSON.stringify(host.lastEnv)).not.toContain("SERVICE");
  });

  test("a migration error aborts at apply-migrations — not live, status failed", async () => {
    const backend = fakeBackend({ applyMigrations: async () => ({ ok: false, appliedNow: [], error: "syntax error" }) });
    const r = await provisionAndDeploy(await input(), deps({ backend }));
    expect(r).toMatchObject({ live: false, abortedAt: "apply-migrations" });
    expect(r.record.status).toBe("failed");
  });

  test("⭐ live RLS not enforced → aborts BEFORE deploying, never goes live", async () => {
    const backend = fakeBackend({ verifyLiveRls: async () => ({ enforced: false, leakedTables: ["t"], inconclusive: [] }) });
    let deployed = false;
    const host = fakeHost({ deploy: async () => ((deployed = true), { url: "x", hostRef: "h" }) });
    const r = await provisionAndDeploy(await input(), deps({ backend, host }));
    expect(r).toMatchObject({ live: false, abortedAt: "verify-live-rls" });
    expect(r.reason).toContain("t");
    expect(deployed).toBe(false); // the frontend deploy was never reached
  });

  test("a host failure leaves the app not-live + recoverable (status failed)", async () => {
    const host = fakeHost({ deploy: async () => { throw new Error("host 500"); } });
    const r = await provisionAndDeploy(await input(), deps({ host }));
    expect(r.live).toBe(false);
    expect(r.record.status).toBe("failed");
  });

  test("re-deploy reuses the project + applies only NEW migrations (idempotent)", async () => {
    const records = memRecords();
    let provisions = 0;
    const backend = fakeBackend({
      ensureProject: async (rec) => ({ handle: { projectRef: rec.projectRef ?? `proj-${++provisions}` }, secrets: { url: "u", anonKey: "a", serviceKey: "s" } }),
    });
    const ws = await passingWorkspace();
    const first = await provisionAndDeploy(await input({ workspacePath: ws }), deps({ records, backend }));
    expect(first.record.appliedMigrations).toEqual(["0001"]);
    const second = await provisionAndDeploy(
      await input({ workspacePath: ws, migrations: [{ id: "0001", sql: "x" }, { id: "0002", sql: "y" }] }),
      deps({ records, backend }),
    );
    expect(provisions).toBe(1); // provisioned once; reused the second time
    expect(second.record.appliedMigrations).toEqual(["0001", "0002"]); // 0001 not re-run
  });

  test("refuses without the gate sentinel (§11 precondition, defense in depth)", async () => {
    const noSentinel = await mkdtemp(join(tmpdir(), "dd-nosent-"));
    tmps.push(noSentinel);
    expect(provisionAndDeploy(await input({ workspacePath: noSentinel }), deps())).rejects.toThrow(/HARD_VERIFY_PASS/);
  });
});

describe("destroy", () => {
  test("deletes the project + the host deployment + secrets, and clears the record", async () => {
    const records = memRecords();
    const secrets = memSecrets();
    let deleted = false;
    let tore = false;
    const backend = fakeBackend({ deleteProject: async () => void (deleted = true) });
    const host = fakeHost({ teardown: async () => void (tore = true) });
    const d = deps({ records, secrets, backend, host });
    await provisionAndDeploy(await input(), d);
    expect(secrets.has("myapp")).toBe(true);

    const res = await destroy("myapp", d);
    expect(res.destroyed).toBe(true);
    expect(deleted).toBe(true);
    expect(tore).toBe(true);
    expect(secrets.has("myapp")).toBe(false);
    expect(records.get("myapp")).toBeNull();
  });

  test("destroy on an unknown app is a no-op", async () => {
    expect(await destroy("ghost", deps())).toEqual({ destroyed: false });
  });
});
