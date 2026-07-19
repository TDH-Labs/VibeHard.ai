import { describe, expect, test } from "bun:test";
import { probeRlsOnce, refFromUrl, resolveDbUrl, SupabaseBackendProvider, type DbExecutor, type SupabaseEnv } from "./supabase.ts";
import type { SupabaseManagementClient } from "./supabase-management.ts";
import type { BackendSecrets, DeploymentRecord, SecretsStore } from "./types.ts";

/** In-memory SecretsStore for tests (the real one is AES-256-GCM on disk). */
function memStore() {
  const m = new Map<string, BackendSecrets>();
  const store: SecretsStore = {
    name: "mem",
    put: async (app, s) => {
      m.set(app, s);
      return `ref:${app}`;
    },
    get: async (app) => m.get(app) ?? null,
    remove: async (app) => {
      m.delete(app);
    },
  };
  return store;
}

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

describe("SupabaseBackendProvider — managed mode (auto-create)", () => {
  const provisioned = {
    ref: "newref", url: "https://newref.supabase.co", region: "us-east-1",
    anonKey: "new-anon", serviceKey: "new-svc",
    dbHost: "aws-1-us-east-1.pooler.supabase.com", dbUser: "postgres.newref", dbPassword: "genpw",
  };

  test("ensureProject CREATES a project and points the provider at it", async () => {
    const provisionCalls: Array<{ name: string; orgId?: string }> = [];
    const fakeMgmt = {
      provisionProject: async (req: { name: string; orgId?: string }) => {
        provisionCalls.push(req);
        return provisioned;
      },
    } as unknown as SupabaseManagementClient;
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch;

    const provider = new SupabaseBackendProvider({ managed: true, appName: "my-app", management: fakeMgmt, fetchImpl });
    const { handle, secrets } = await provider.ensureProject(record0, { orgRef: "org" });

    expect(provisionCalls[0]?.name).toBe("my-app");
    expect(handle.projectRef).toBe("newref");
    // secrets now carry the DB connection (so a redeploy can reload the unrecoverable db password)
    expect(secrets).toEqual({
      url: "https://newref.supabase.co", anonKey: "new-anon", serviceKey: "new-svc",
      dbHost: "aws-1-us-east-1.pooler.supabase.com", dbUser: "postgres.newref", dbPassword: "genpw",
    });
    // proof the provider REPOINTED: the live-RLS probe now hits the NEW project's REST endpoint
    await provider.verifyLiveRls(handle, ["notes"]);
    expect(seen[0]).toContain("https://newref.supabase.co/rest/v1/notes");
  });

  test("managed REDEPLOY reloads the created project's connection (incl. db password) from the store", async () => {
    const store = memStore();
    const okMgmt = { provisionProject: async () => provisioned } as unknown as SupabaseManagementClient;

    // first deploy: create → persists the full connection to the shared store
    const first = new SupabaseBackendProvider({ managed: true, appName: "app", management: okMgmt, secretsStore: store });
    const r1 = await first.ensureProject(record0, { orgRef: "o" });
    expect(r1.secrets.dbPassword).toBe("genpw");
    expect(await store.get(record0.app)).not.toBeNull(); // persisted under the app key

    // REDEPLOY: a fresh provider instance + the record now carrying the projectRef → reuse path.
    // The Management client MUST NOT be called (no second create), and the db password is reloaded.
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch;
    const failMgmt = {
      provisionProject: async () => {
        throw new Error("must not create on redeploy");
      },
    } as unknown as SupabaseManagementClient;
    const second = new SupabaseBackendProvider({ managed: true, appName: "app", management: failMgmt, secretsStore: store, fetchImpl });
    const r2 = await second.ensureProject({ ...record0, projectRef: "newref" }, { orgRef: "o" });

    expect(r2.handle.projectRef).toBe("newref");
    expect(r2.secrets.dbPassword).toBe("genpw"); // the unrecoverable bit survived the redeploy
    // repointed at the created project: the RLS probe hits its URL (not the empty default)
    await second.verifyLiveRls(r2.handle, ["notes"]);
    expect(seen[0]).toContain("https://newref.supabase.co/rest/v1/notes");
  });

  test("THE BUG THIS CLOSES: a claimed projectRef with NO stored secrets throws immediately — never silently falls through to an empty connection (found live 2026-07-19: this used to fall through to the EMPTY constructor default, and every downstream probe then spent the ENTIRE ~190s×3-table retry budget — ~9.5 minutes — hitting a URL with no host, on THREE separate ship attempts, before finally failing closed anyway)", async () => {
    const emptyStore = memStore(); // durable, but genuinely has nothing for this app
    const failMgmt = { provisionProject: async () => { throw new Error("must not create — this is a reuse"); } } as unknown as SupabaseManagementClient;
    const provider = new SupabaseBackendProvider({ managed: true, appName: "app", management: failMgmt, secretsStore: emptyStore });
    await expect(provider.ensureProject({ ...record0, projectRef: "orphaned-ref" }, { orgRef: "o" })).rejects.toThrow(
      /projectRef "orphaned-ref" but no connection secrets are stored/,
    );
  });

  test("a record with an existing projectRef is reused (managed mode does NOT re-create)", async () => {
    let created = false;
    const fakeMgmt = {
      provisionProject: async () => {
        created = true;
        throw new Error("should not create");
      },
    } as unknown as SupabaseManagementClient;
    const provider = new SupabaseBackendProvider({ managed: true, appName: "x", management: fakeMgmt, env });
    const { handle } = await provider.ensureProject({ ...record0, projectRef: "existing" }, { orgRef: "org" });
    expect(handle.projectRef).toBe("existing");
    expect(created).toBe(false);
  });
});

describe("refFromUrl / resolveDbUrl", () => {
  test("ref is the first hostname label", () => {
    expect(refFromUrl("https://abc123.supabase.co")).toBe("abc123");
  });
  test("prefers a complete SUPABASE_DB_URL (direct or pooler) as-is", () => {
    expect(resolveDbUrl({ ...env, dbUrl: "postgresql://real@host/db", dbPassword: undefined })).toBe("postgresql://real@host/db");
  });
  test("injects the discrete password into a placeholder POOLER URL, preserving host + user", () => {
    const out = resolveDbUrl({
      ...env,
      dbUrl: "postgresql://postgres.abc123:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
      dbPassword: "p@ss/word",
    });
    expect(out).toContain("@aws-0-us-east-1.pooler.supabase.com:5432/postgres"); // pooler host kept
    expect(out).toContain("postgres.abc123"); // pooler username kept
    expect(out).toContain("%40"); // '@' in the password got percent-encoded
    expect(out).not.toContain("YOUR-PASSWORD");
  });
  test("with only a password (no URL), assembles a direct connection from the ref", () => {
    const out = resolveDbUrl({ url: env.url, anonKey: "a", serviceKey: "s", dbPassword: "p@ss/word" });
    expect(out).toContain("@db.abc123.supabase.co:5432/postgres");
    expect(out).toContain(encodeURIComponent("p@ss/word")); // p%40ss%2Fword
  });
  test("with a pooler SUPABASE_DB_HOST, assembles the postgres.<ref>@host pooler form", () => {
    const out = resolveDbUrl({ url: env.url, anonKey: "a", serviceKey: "s", dbPassword: "p@ss/word", dbHost: "aws-1-us-east-1.pooler.supabase.com" });
    expect(out).toContain("postgres.abc123:"); // tenant rides in the username
    expect(out).toContain("@aws-1-us-east-1.pooler.supabase.com:5432/postgres");
    expect(out).toContain(encodeURIComponent("p@ss/word"));
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
    expect(fx.ran[0]).toContain("_vibehard_migrations"); // the ledger is ensured first
    expect(fx.ran.some((s) => s.includes("-- m2") && s.includes("insert into _vibehard_migrations") && s.includes("begin"))).toBe(true); // m2 applied + recorded in one txn
    expect(fx.ran.some((s) => s.includes("-- m1"))).toBe(false); // m1 (already applied) is skipped
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

  test("F2: resume is IDEMPOTENT — a lost record does not double-apply a non-idempotent migration (real pglite)", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    const executor = { exec: async (sql: string) => { await db.exec(sql); }, end: async () => {} };
    const p = new SupabaseBackendProvider({ env, executorFactory: () => executor, fetchImpl: fetchOf({}) });
    const migs = [{ id: "0001", sql: `create table t (id int primary key); alter table t enable row level security; create policy p on t for all using (true);` }];
    expect((await p.applyMigrations(h, migs, [])).appliedNow).toEqual(["0001"]);
    // resume with the SAME empty record (side-file lost) → create policy must NOT re-run → no error, skipped via the ledger
    const r2 = await p.applyMigrations(h, migs, []);
    expect(r2.ok).toBe(true);
    expect(r2.appliedNow).toEqual([]);
    await db.close();
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
    const r = await p.verifyLiveRls(h, ["open", "secure", "denied"], ["open", "secure", "denied"]);
    expect(r.enforced).toBe(false);
    expect(r.leakedTables).toEqual(["open"]);

    const ok = await p.verifyLiveRls(h, ["secure", "denied"], ["secure", "denied"]);
    expect(ok).toEqual({ enforced: true, leakedTables: [], inconclusive: [] });
  });
  test("EMPTY-TABLE blind spot closed: a table with NO RLS in the migrations is a leak even with zero rows", async () => {
    const p = new SupabaseBackendProvider({
      env,
      executorFactory: () => fakeExecutor().exec,
      fetchImpl: fetchOf({ ghost: { status: 200, body: [] } }), // empty NOW, but RLS is off → every future row leaks
    });
    const r = await p.verifyLiveRls(h, ["ghost"], ["some_other_table"]); // ghost not in the RLS-enabled set
    expect(r.enforced).toBe(false);
    expect(r.leakedTables).toEqual(["ghost"]);
  });
  test("transport/network errors FAIL CLOSED (inconclusive ⇒ not enforced)", async () => {
    const throwing = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const p = new SupabaseBackendProvider({ env, executorFactory: () => fakeExecutor().exec, fetchImpl: throwing, sleepImpl: async () => {} });
    const r = await p.verifyLiveRls(h, ["x"], ["x"]);
    expect(r.enforced).toBe(false);
    expect(r.inconclusive).toEqual(["x"]);
  });
});

describe("probeRlsOnce — pure per-probe verdict (2026-07-19)", () => {
  const fetchOnce = (r: { status: number; body: unknown }) => (async () => ({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body })) as unknown as typeof fetch;

  test("200 + rows → leak; 200 + [] → secure; 401/403 → secure; other status → inconclusive; unexpected 200 shape → inconclusive", async () => {
    expect(await probeRlsOnce(fetchOnce({ status: 200, body: [{ id: 1 }] }), "u", "k")).toBe("leak");
    expect(await probeRlsOnce(fetchOnce({ status: 200, body: [] }), "u", "k")).toBe("secure");
    expect(await probeRlsOnce(fetchOnce({ status: 401, body: {} }), "u", "k")).toBe("secure");
    expect(await probeRlsOnce(fetchOnce({ status: 403, body: {} }), "u", "k")).toBe("secure");
    expect(await probeRlsOnce(fetchOnce({ status: 404, body: { message: "not found" } }), "u", "k")).toBe("inconclusive");
    expect(await probeRlsOnce(fetchOnce({ status: 503, body: {} }), "u", "k")).toBe("inconclusive");
    expect(await probeRlsOnce(fetchOnce({ status: 200, body: { not: "an array" } }), "u", "k")).toBe("inconclusive");
  });

  test("a transport error (fetch throws) → inconclusive, never thrown out (fail-closed, not fail-crashed)", async () => {
    const throwing = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await probeRlsOnce(throwing, "u", "k")).toBe("inconclusive");
  });
});

describe("verifyLiveRls — readiness retry for a just-provisioned project (found live 2026-07-19, acceptance test prompt C: migrations apply over a direct Postgres connection and succeed immediately, but PostgREST — a SEPARATE service — needs a moment to notice brand-new tables; the very same tables returned a clean 200+[] by hand ~2 minutes later, proving this was transient propagation lag, not a real leak)", () => {
  const h = { projectRef: "abc123" };

  function countingFetch(byTable: Record<string, Array<{ status: number; body: unknown }>>): { fetchImpl: typeof fetch; calls: Record<string, number> } {
    const calls: Record<string, number> = {};
    const fetchImpl = (async (url: string) => {
      const table = new URL(url).pathname.split("/rest/v1/")[1] ?? "";
      const n = (calls[table] = (calls[table] ?? 0) + 1);
      const seq = byTable[table] ?? [];
      const r = seq[Math.min(n - 1, seq.length - 1)] ?? { status: 404, body: { message: "not found" } };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  test("inconclusive on early attempts, then resolves secure → NOT recorded as inconclusive (the retry that closes this class of failure)", async () => {
    const { fetchImpl, calls } = countingFetch({
      teams: [{ status: 404, body: {} }, { status: 404, body: {} }, { status: 200, body: [] }], // 3rd attempt: PostgREST has caught up
    });
    const p = new SupabaseBackendProvider({ env, executorFactory: () => fakeExecutor().exec, fetchImpl, sleepImpl: async () => {} });
    const r = await p.verifyLiveRls(h, ["teams"], ["teams"]);
    expect(r).toEqual({ enforced: true, leakedTables: [], inconclusive: [] });
    expect(calls.teams).toBe(3); // stopped retrying the moment it got a conclusive answer
  });

  test("STILL inconclusive after the full retry budget → fail-closed, exactly as before (the guarantee is NOT weakened — it just isn't triggered by a transient readiness gap anymore)", async () => {
    const { fetchImpl, calls } = countingFetch({ orders: [] }); // every attempt 404s (falls through to the default)
    const p = new SupabaseBackendProvider({ env, executorFactory: () => fakeExecutor().exec, fetchImpl, sleepImpl: async () => {} });
    const r = await p.verifyLiveRls(h, ["orders"], ["orders"]);
    expect(r.enforced).toBe(false);
    expect(r.inconclusive).toEqual(["orders"]);
    expect(calls.orders).toBe(20); // bounded — retried the full budget, never more
  });

  test("a genuine LEAK on the FIRST attempt is recorded immediately — zero retries; retrying a real leak would only waste time, never change the verdict", async () => {
    const { fetchImpl, calls } = countingFetch({ secrets: [{ status: 200, body: [{ id: 1 }] }] });
    const p = new SupabaseBackendProvider({ env, executorFactory: () => fakeExecutor().exec, fetchImpl, sleepImpl: async () => {} });
    const r = await p.verifyLiveRls(h, ["secrets"], ["secrets"]);
    expect(r.leakedTables).toEqual(["secrets"]);
    expect(calls.secrets).toBe(1);
  });

  test("a genuine DENY (401/403) on the first attempt is ALSO immediate — zero retries", async () => {
    const { fetchImpl, calls } = countingFetch({ users: [{ status: 401, body: {} }] });
    const p = new SupabaseBackendProvider({ env, executorFactory: () => fakeExecutor().exec, fetchImpl, sleepImpl: async () => {} });
    const r = await p.verifyLiveRls(h, ["users"], ["users"]);
    expect(r.enforced).toBe(true);
    expect(calls.users).toBe(1);
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
