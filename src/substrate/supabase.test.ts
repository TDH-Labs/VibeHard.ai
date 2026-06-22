import { describe, expect, test } from "bun:test";
import { refFromUrl, resolveDbUrl, SupabaseBackendProvider, type DbExecutor, type SupabaseEnv } from "./supabase.ts";
import type { DeploymentRecord } from "./types.ts";

const env: SupabaseEnv = { url: "https://abc123.supabase.co", anonKey: "anon-key", serviceKey: "svc-key", dbPassword: "p@ss/word" };
const record0: DeploymentRecord = { app: "a", customerOrgRef: "org", projectRef: null, hostRef: null, url: null, appliedMigrations: [], secretsRef: null, status: "provisioning", updatedAt: "t" };

function fakeExecutor(opts: { throwOn?: string } = {}) {
  const ran: string[] = [];
  let ended = false;
  const exec: DbExecutor = {
    exec: async (sql: string) => {
      ran.push(sql);
      if (opts.throwOn && sql.includes(opts.throwOn)) throw new Error("boom");
    },
    end: async () => {
      ended = true;
    },
  };
  return { exec, ran, ended: () => ended };
}

const fetchOf = (byTable: Record<string, { status: number; body: unknown }>) =>
  (async (url: string) => {
    const table = new URL(url).pathname.split("/rest/v1/")[1] ?? "";
    const r = byTable[table] ?? { status: 404, body: { message: "not found" } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;

describe("refFromUrl / resolveDbUrl", () => {
  test("ref is the first hostname label", () => {
    expect(refFromUrl("https://abc123.supabase.co")).toBe("abc123");
  });
  test("prefers a real SUPABASE_DB_URL", () => {
    expect(resolveDbUrl({ ...env, dbUrl: "postgresql://real@host/db", dbPassword: undefined })).toBe("postgresql://real@host/db");
  });
  test("ignores the [YOUR-PASSWORD] placeholder URL and builds from the password (encoded)", () => {
    const out = resolveDbUrl({ ...env, dbUrl: "postgresql://postgres:[YOUR-PASSWORD]@x:5432/postgres" });
    expect(out).toContain("@db.abc123.supabase.co:5432/postgres");
    expect(out).toContain(encodeURIComponent("p@ss/word")); // p%40ss%2Fword — no encoding footgun
    expect(out).not.toContain("[YOUR-PASSWORD]");
  });
  test("throws when neither a real URL nor a password is available", () => {
    expect(() => resolveDbUrl({ url: env.url, anonKey: "a", serviceKey: "s" })).toThrow(/SUPABASE_DB_PASSWORD/);
  });
});

describe("ensureProject — adopt the existing project", () => {
  const p = new SupabaseBackendProvider({ env, executorFactory: () => fakeExecutor().exec, fetchImpl: fetchOf({}) });
  test("derives the ref from the URL and returns env secrets", async () => {
    const { handle, secrets } = await p.ensureProject(record0, { orgRef: "org" });
    expect(handle.projectRef).toBe("abc123");
    expect(secrets).toEqual({ url: env.url, anonKey: "anon-key", serviceKey: "svc-key" });
  });
  test("reuses a recorded projectRef (idempotent)", async () => {
    const { handle } = await p.ensureProject({ ...record0, projectRef: "existing-ref" }, { orgRef: "org" });
    expect(handle.projectRef).toBe("existing-ref");
  });
});

describe("applyMigrations", () => {
  const h = { projectRef: "abc123" };
  test("runs only not-yet-applied migrations and reports them; always closes the connection", async () => {
    const fx = fakeExecutor();
    const p = new SupabaseBackendProvider({ env, executorFactory: () => fx.exec, fetchImpl: fetchOf({}) });
    const r = await p.applyMigrations(h, [{ id: "m1", sql: "-- m1" }, { id: "m2", sql: "-- m2" }], ["m1"]);
    expect(r).toMatchObject({ ok: true, appliedNow: ["m2"] });
    expect(fx.ran).toEqual(["-- m2"]);
    expect(fx.ended()).toBe(true);
  });
  test("a nothing-to-do run opens no connection", async () => {
    let opened = false;
    const p = new SupabaseBackendProvider({ env, executorFactory: () => { opened = true; return fakeExecutor().exec; }, fetchImpl: fetchOf({}) });
    expect(await p.applyMigrations(h, [{ id: "m1", sql: "x" }], ["m1"])).toMatchObject({ ok: true, appliedNow: [] });
    expect(opened).toBe(false);
  });
  test("a SQL error stops at the failing migration → ok:false with partial progress", async () => {
    const fx = fakeExecutor({ throwOn: "m2" });
    const p = new SupabaseBackendProvider({ env, executorFactory: () => fx.exec, fetchImpl: fetchOf({}) });
    const r = await p.applyMigrations(h, [{ id: "m1", sql: "ok m1" }, { id: "m2", sql: "bad m2" }, { id: "m3", sql: "ok m3" }], []);
    expect(r.ok).toBe(false);
    expect(r.appliedNow).toEqual(["m1"]); // m3 never attempted
    expect(r.error).toContain("m2");
    expect(fx.ended()).toBe(true); // finally still closed it
  });
});

describe("verifyLiveRls — the live anonymous probe", () => {
  const h = { projectRef: "abc123" };
  test("a table that returns rows to anon is a LEAK; empty/denied are enforced", async () => {
    const p = new SupabaseBackendProvider({
      env,
      executorFactory: () => fakeExecutor().exec,
      fetchImpl: fetchOf({
        open: { status: 200, body: [{ id: 1 }] }, // anon saw a row → leak
        secure: { status: 200, body: [] }, // RLS denies → empty
        denied: { status: 401, body: { message: "permission denied" } }, // grant denies
      }),
    });
    const r = await p.verifyLiveRls(h, ["open", "secure", "denied"]);
    expect(r.enforced).toBe(false);
    expect(r.leakedTables).toEqual(["open"]);

    const ok = await p.verifyLiveRls(h, ["secure", "denied"]);
    expect(ok).toEqual({ enforced: true, leakedTables: [] });
  });
  test("transport/network errors never flip enforcement (don't fail on noise)", async () => {
    const throwing = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const p = new SupabaseBackendProvider({ env, executorFactory: () => fakeExecutor().exec, fetchImpl: throwing });
    expect(await p.verifyLiveRls(h, ["x"])).toEqual({ enforced: true, leakedTables: [] });
  });
});

describe("configureAuth / deleteProject — v1 no-ops (adopt-existing)", () => {
  const p = new SupabaseBackendProvider({ env, executorFactory: () => fakeExecutor().exec, fetchImpl: fetchOf({}) });
  test("resolve without throwing", async () => {
    await expect(p.configureAuth({ projectRef: "abc123" }, "https://app")).resolves.toBeUndefined();
    await expect(p.deleteProject({ projectRef: "abc123" })).resolves.toBeUndefined();
  });
  test("provider name", () => {
    expect(p.name).toBe("supabase");
  });
});
