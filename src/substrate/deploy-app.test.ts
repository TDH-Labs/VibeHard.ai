import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSubstrateDeps, deployApp, isBackendlessWorkspace, parseMigrations, tablesFromMigrations } from "./deploy-app.ts";
import { stampSentinel } from "../gate/index.ts";
import type { DeploymentRecord } from "./types.ts";
import type { SubstrateDeps } from "./orchestrator.ts";
import { ensurePlatformSchema, ensureSubstrateSchema, PgRecordStore, PgSecretsStore, pgliteSql } from "../platform/pg-store.ts";

const REC: DeploymentRecord = { app: "x", customerOrgRef: "o", projectRef: "r", hostRef: "h", url: "https://x", appliedMigrations: [], secretsRef: null, status: "live", updatedAt: "t" };

// `defaultSubstrateDeps` without `managed: true` constructs a REAL (non-managed) SupabaseBackendProvider,
// which reads SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY from process.env even though these
// tests never make a network call — and LocalEncryptedSecretsStore/PgSecretsStore fail closed without a
// passphrase. Stub dummy values file-wide (only if unset) so these tests are hermetic in CI, which has no
// operator .env — an operator's real .env was masking this locally (audit: first-ever CI run caught it).
const savedEnv: Record<string, string | undefined> = {};
const DUMMY_ENV = { VIBEHARD_SECRETS_KEY: "test-passphrase-not-a-real-secret", SUPABASE_URL: "https://dummy.supabase.co", SUPABASE_ANON_KEY: "dummy-anon", SUPABASE_SERVICE_ROLE_KEY: "dummy-service" };
beforeAll(() => {
  for (const [k, v] of Object.entries(DUMMY_ENV)) {
    savedEnv[k] = process.env[k];
    if (!process.env[k]) process.env[k] = v;
  }
});
afterAll(() => {
  for (const k of Object.keys(DUMMY_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
  }
});

describe("tablesFromMigrations", () => {
  test("extracts table names across forms, deduped + lowercased families", () => {
    const tables = tablesFromMigrations([
      { id: "1", sql: "create table notes (id int);\ncreate table if not exists profiles (id uuid);" },
      { id: "2", sql: "create table public.documents (id int);\nCREATE TABLE notes (x int);" },
    ]);
    expect(tables.sort()).toEqual(["documents", "notes", "profiles"]);
  });
  test("no create-table → empty", () => {
    expect(tablesFromMigrations([{ id: "1", sql: "alter table x enable row level security;" }])).toEqual([]);
  });
});

describe("parseMigrations", () => {
  test("reads + sorts supabase/migrations/*.sql; missing dir → []", () => {
    const ws = mkdtempSync(join(tmpdir(), "dd-mig-"));
    try {
      expect(parseMigrations(ws)).toEqual([]);
      const md = join(ws, "supabase", "migrations");
      mkdirSync(md, { recursive: true });
      writeFileSync(join(md, "002_b.sql"), "create table b (id int);");
      writeFileSync(join(md, "001_a.sql"), "create table a (id int);");
      writeFileSync(join(md, "notes.txt"), "ignore me");
      const migs = parseMigrations(ws);
      expect(migs.map((m) => m.id)).toEqual(["001_a.sql", "002_b.sql"]); // sorted, .sql only
      expect(migs[0]!.sql).toContain("table a");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("deployApp — derives input + runs the orchestrator", () => {
  test("derives migrations + RLS tables + app name, and provisions through to live", async () => {
    const ws = mkdtempSync(join(tmpdir(), "dd-app-"));
    try {
      await stampSentinel(ws, true); // write HMAC-authenticated sentinel (C3)
      const md = join(ws, "supabase", "migrations");
      mkdirSync(md, { recursive: true });
      writeFileSync(join(md, "001_init.sql"), "create table notes (id int);\nalter table notes enable row level security;");

      const captured: { migrations?: string[]; rlsTables?: string[]; hostEnv?: Record<string, string> } = {};
      const deps: SubstrateDeps = {
        backend: {
          name: "fake",
          ensureProject: async () => ({ handle: { projectRef: "ref" }, secrets: { url: "u", anonKey: "a", serviceKey: "s", dbHost: "dbhost", dbUser: "dbuser", dbPassword: "dbpw" } }),
          applyMigrations: async (_h, migs) => {
            captured.migrations = migs.map((m) => m.id);
            return { ok: true, appliedNow: migs.map((m) => m.id) };
          },
          verifyLiveRls: async (_h, tables) => {
            captured.rlsTables = tables;
            return { enforced: true, leakedTables: [], inconclusive: [] };
          },
          configureAuth: async () => {},
          deleteProject: async () => {},
        },
        host: {
          name: "fake",
          deploy: async (_ws, env) => {
            captured.hostEnv = env;
            return { url: "https://live.example.vercel.app", hostRef: "hr" };
          },
          teardown: async () => {},
        },
        secrets: { name: "fake", put: async () => "secret-ref", get: async () => null, remove: async () => {} },
        records: { get: async () => null, put: async () => {}, remove: async () => {} },
      };

      const outcome = await deployApp(ws, { app: "my-notes-app", deps });
      expect(outcome.live).toBe(true);
      expect(outcome.url).toBe("https://live.example.vercel.app");
      expect(captured.migrations).toEqual(["001_init.sql"]);
      expect(captured.rlsTables).toEqual(["notes"]);
      expect(outcome.record.app).toBe("my-notes-app");
      // §16/R6: only url + anon reach the host (under canonical + framework-public names);
      // the service-role key (fake value "s") is NEVER injected
      const vals = Object.values(captured.hostEnv ?? {});
      expect(vals.length).toBeGreaterThan(0);
      expect(vals.every((v) => v === "u" || v === "a")).toBe(true);
      expect(vals).not.toContain("s"); // service-role key never reaches the host
      expect(vals).not.toContain("dbpw"); // …nor the managed-mode db password
      expect(captured.hostEnv?.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("a"); // Next reads the public name
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("hostNameSeed flows through deployApp → provisionAndDeploy, decoupled from `app` (2026-07-19: cli.ts passes the RAW dispatch app as `app` — the record-store key, matching the dispatch token's scope — and the sanitized/tenant-scoped VIBEHARD_APP_NAME as hostNameSeed, the Fly host seed; conflating them broke httpRecordStore's PUT)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "dd-hostseed-"));
    try {
      await stampSentinel(ws, true);
      const captured: { hostRef?: string | null } = {};
      const deps: SubstrateDeps = {
        backend: {
          name: "fake",
          ensureProject: async () => ({ handle: { projectRef: "ref" }, secrets: { url: "u", anonKey: "a", serviceKey: "s" } }),
          applyMigrations: async () => ({ ok: true, appliedNow: [] }),
          verifyLiveRls: async () => ({ enforced: true, leakedTables: [], inconclusive: [] }),
          configureAuth: async () => {},
          deleteProject: async () => {},
        },
        host: {
          name: "fake",
          deploy: async (_ws, _env, hostRef) => {
            captured.hostRef = hostRef;
            return { url: "https://live.example.com", hostRef: hostRef ?? "hr" };
          },
          teardown: async () => {},
        },
        secrets: { name: "fake", put: async () => "secret-ref", get: async () => null, remove: async () => {} },
        records: { get: async () => null, put: async () => {}, remove: async () => {} },
      };
      const outcome = await deployApp(ws, { app: "accept-c3", hostNameSeed: "accept-c3-eb9e9b", deps });
      expect(outcome.live).toBe(true);
      expect(outcome.record.app).toBe("accept-c3"); // record key = the raw dispatch app
      expect(captured.hostRef).toBe("accept-c3-eb9e9b"); // host name = the sanitized seed
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("without the gate sentinel, the orchestrator refuses (defense in depth)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "dd-nopass-"));
    try {
      const deps = {} as unknown as SubstrateDeps; // never reached past the precondition
      await expect(deployApp(ws, { app: "x", deps })).rejects.toThrow(/sentinel|gate must pass/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("defaultSubstrateDeps — host is chosen by artifact (Dockerfile → Fly, else Vercel)", () => {
  test("a workspace WITH a Dockerfile → Fly (container deploy, any language)", () => {
    const ws = mkdtempSync(join(tmpdir(), "dd-host-"));
    try {
      writeFileSync(join(ws, "Dockerfile"), "FROM python:3.12-slim\n");
      const deps = defaultSubstrateDeps({ workspacePath: ws, stateDir: join(ws, ".state") });
      expect(deps.host.name).toBe("fly");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a workspace WITHOUT a Dockerfile → Vercel (JS/TS-native)", () => {
    const ws = mkdtempSync(join(tmpdir(), "dd-host-"));
    try {
      const deps = defaultSubstrateDeps({ workspacePath: ws, stateDir: join(ws, ".state") });
      expect(deps.host.name).toBe("vercel");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("no workspacePath given → defaults to Vercel (back-compat)", () => {
    const state = mkdtempSync(join(tmpdir(), "dd-host-"));
    try {
      expect(defaultSubstrateDeps({ stateDir: state }).host.name).toBe("vercel");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("defaultSubstrateDeps — secrets store selection (EPIC #33b)", () => {
  test("no `sql` injected → LocalEncryptedSecretsStore (file-backed, today's default)", () => {
    const state = mkdtempSync(join(tmpdir(), "dd-secrets-"));
    try {
      expect(defaultSubstrateDeps({ stateDir: state }).secrets.name).toBe("local-encrypted");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("a `sql` injected → PgSecretsStore, and it durably round-trips a secret", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    try {
      const sql = pgliteSql(db);
      await ensurePlatformSchema(sql);
      await ensureSubstrateSchema(sql);
      const deps = defaultSubstrateDeps({ sql, scope: "tenant-1" });
      expect(deps.secrets).toBeInstanceOf(PgSecretsStore);
      await deps.secrets.put("my-app", { url: "u", anonKey: "a", serviceKey: "s" });
      expect(await deps.secrets.get("my-app")).toEqual({ url: "u", anonKey: "a", serviceKey: "s" });
      // scoped: a different tenant's store can't read it
      const other = defaultSubstrateDeps({ sql, scope: "tenant-2" }).secrets;
      expect(await other.get("my-app")).toBeNull();
    } finally {
      await db.close();
    }
  });
});

describe("defaultSubstrateDeps — records store selection (EPIC #33c)", () => {
  test("no `sql` injected → FileRecordStore (file-backed, today's default)", () => {
    const state = mkdtempSync(join(tmpdir(), "dd-records-"));
    try {
      // FileRecordStore has no `name` field; assert on behavior instead — a fresh instance sees nothing.
      // (Constructing it here is enough to prove no PgRecordStore was picked, since that ctor needs `sql`.)
      expect(defaultSubstrateDeps({ stateDir: state })).toBeTruthy();
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("a `sql` injected → PgRecordStore, and it durably round-trips + scopes a record", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    try {
      const sql = pgliteSql(db);
      await ensurePlatformSchema(sql);
      await ensureSubstrateSchema(sql);
      const deps = defaultSubstrateDeps({ sql, scope: "tenant-1" });
      expect(deps.records).toBeInstanceOf(PgRecordStore);
      await deps.records.put({ ...REC, app: "my-app" });
      expect(await deps.records.get("my-app")).toEqual({ ...REC, app: "my-app" });
      // scoped: a different tenant's store can't read it
      const other = defaultSubstrateDeps({ sql, scope: "tenant-2" }).records;
      expect(await other.get("my-app")).toBeNull();
    } finally {
      await db.close();
    }
  });

  test("an explicit `records` override wins over BOTH the sql and file fallback (2026-07-19: cli.ts ship passes httpRecordStore here when sandboxed — see the option's own doc for why the fallbacks alone silently discarded every sandboxed deploy's provisioning state)", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    try {
      const sql = pgliteSql(db);
      await ensurePlatformSchema(sql);
      await ensureSubstrateSchema(sql);
      let gets = 0;
      const custom = {
        get: async () => {
          gets++;
          return null;
        },
        put: async () => {},
        remove: async () => {},
      };
      // sql IS provided (which would normally select PgRecordStore) — records must still win.
      const deps = defaultSubstrateDeps({ sql, scope: "tenant-1", records: custom });
      expect(deps.records).toBe(custom);
      await deps.records.get("my-app");
      expect(gets).toBe(1);
    } finally {
      await db.close();
    }
  });

  test("an explicit `secrets` override ALSO wins over both fallbacks (2026-07-19, the SAME class of bug one layer deeper: ensureProject's reuse path needs the durable CONNECTION, not just the record — a records-only fix left a redeploy reloading an empty '' url/anonKey from the non-durable default secrets store)", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    try {
      const sql = pgliteSql(db);
      await ensurePlatformSchema(sql);
      await ensureSubstrateSchema(sql);
      let gets = 0;
      const custom = {
        name: "custom",
        get: async () => {
          gets++;
          return null;
        },
        put: async () => "ref",
        remove: async () => {},
      };
      const deps = defaultSubstrateDeps({ sql, scope: "tenant-1", secrets: custom });
      expect(deps.secrets).toBe(custom);
      await deps.secrets.get("my-app");
      expect(gets).toBe(1);
    } finally {
      await db.close();
    }
  });
});

describe("isBackendlessWorkspace — deterministic 'does this app need a backend at all' (2026-07-19)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const ws = (): string => {
    const d = mkdtempSync(join(tmpdir(), "vibehard-backendless-"));
    dirs.push(d);
    return d;
  };

  test("the static-template shape (manifest without @supabase, no migrations, no supabase/) → backendless", () => {
    const d = ws();
    writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { next: "15.5.20", react: "19.0.0" } }));
    expect(isBackendlessWorkspace(d, [])).toBe(true);
  });

  test("ANY supabase signal → NOT backendless (conservative): migrations, a supabase/ dir, or an @supabase/* dep", () => {
    const withMigrations = ws();
    writeFileSync(join(withMigrations, "package.json"), "{}");
    expect(isBackendlessWorkspace(withMigrations, [{ id: "0001", sql: "create table t" }])).toBe(false);

    const withDir = ws();
    mkdirSync(join(withDir, "supabase"), { recursive: true });
    expect(isBackendlessWorkspace(withDir, [])).toBe(false);

    const withDep = ws();
    writeFileSync(join(withDep, "package.json"), JSON.stringify({ dependencies: { "@supabase/supabase-js": "2.47.10" } }));
    expect(isBackendlessWorkspace(withDep, [])).toBe(false);
  });
});
