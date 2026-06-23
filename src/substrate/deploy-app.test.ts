import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSubstrateDeps, deployApp, parseMigrations, tablesFromMigrations } from "./deploy-app.ts";
import { SENTINEL_REL } from "../gate/index.ts";
import type { SubstrateDeps } from "./orchestrator.ts";

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
      mkdirSync(join(ws, ".gate"), { recursive: true });
      writeFileSync(join(ws, SENTINEL_REL), "ok"); // a gated, passing workspace
      const md = join(ws, "supabase", "migrations");
      mkdirSync(md, { recursive: true });
      writeFileSync(join(md, "001_init.sql"), "create table notes (id int);\nalter table notes enable row level security;");

      const captured: { migrations?: string[]; rlsTables?: string[]; hostEnv?: Record<string, string> } = {};
      const deps: SubstrateDeps = {
        backend: {
          name: "fake",
          ensureProject: async () => ({ handle: { projectRef: "ref" }, secrets: { url: "u", anonKey: "a", serviceKey: "s" } }),
          applyMigrations: async (_h, migs) => {
            captured.migrations = migs.map((m) => m.id);
            return { ok: true, appliedNow: migs.map((m) => m.id) };
          },
          verifyLiveRls: async (_h, tables) => {
            captured.rlsTables = tables;
            return { enforced: true, leakedTables: [] };
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
        records: { get: () => null, put: () => {}, remove: () => {} },
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
      expect(vals).not.toContain("s");
      expect(captured.hostEnv?.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("a"); // Next reads the public name
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
  // The store fails closed without a passphrase; provide a dummy so construction succeeds
  // regardless of whether an operator .env is loaded. This test only inspects host selection.
  const prevKey = process.env.DRYDOCK_SECRETS_KEY;
  beforeAll(() => {
    if (!process.env.DRYDOCK_SECRETS_KEY) process.env.DRYDOCK_SECRETS_KEY = "test-passphrase-not-a-real-secret";
  });
  afterAll(() => {
    if (prevKey === undefined) delete process.env.DRYDOCK_SECRETS_KEY;
  });

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
