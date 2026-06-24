/**
 * LIVE composition e2e — deployApp drives the REAL Supabase backend + REAL encrypted
 * secrets store through the orchestrator against the actual project (fake host, since the
 * Vercel leg is proven separately). Proves: gate-passed workspace → migrate LIVE → verify
 * live RLS → encrypt secrets at rest → deploy → live. GUARDED + self-cleaning (drops the
 * probe table, removes the temp state).
 *
 *   SUPABASE_DB_HOST=aws-1-us-east-1.pooler.supabase.com VIBEHARD_INTEGRATION=1 \
 *     bun test src/substrate/deploy-app.integration.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { deployApp } from "./deploy-app.ts";
import { FileRecordStore } from "./record.ts";
import { LocalEncryptedSecretsStore } from "./secrets.ts";
import { resolveDbUrl, SupabaseBackendProvider, type SupabaseEnv } from "./supabase.ts";
import { SENTINEL_REL } from "../gate/index.ts";
import type { SubstrateDeps } from "./orchestrator.ts";
import type { HostProvider } from "./types.ts";

const RUN =
  !!process.env.VIBEHARD_INTEGRATION &&
  !!process.env.SUPABASE_URL &&
  !!process.env.SUPABASE_ANON_KEY &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
  (!!process.env.SUPABASE_DB_PASSWORD || !!process.env.SUPABASE_DB_URL) &&
  !!process.env.VIBEHARD_SECRETS_KEY;
const maybe = RUN ? test : test.skip;
const TABLE = "_vibehard_e2e";

function envFrom(): SupabaseEnv {
  return {
    url: process.env.SUPABASE_URL!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    dbUrl: process.env.SUPABASE_DB_URL,
    dbPassword: process.env.SUPABASE_DB_PASSWORD,
    dbHost: process.env.SUPABASE_DB_HOST,
    dbPort: process.env.SUPABASE_DB_PORT ? Number(process.env.SUPABASE_DB_PORT) : undefined,
  };
}

afterAll(async () => {
  if (!RUN) return;
  const db = new SQL(resolveDbUrl(envFrom()));
  try {
    await db.unsafe(`drop table if exists ${TABLE}; notify pgrst, 'reload schema';`).simple();
  } finally {
    await db.end().catch(() => {});
  }
});

describe("LIVE e2e — deployApp provisions a real Supabase backend (fake host)", () => {
  maybe(
    "gate-passed workspace → migrate live → verify RLS → encrypt secrets → deploy → live",
    async () => {
      const ws = mkdtempSync(join(tmpdir(), "dd-e2e-"));
      const stateDir = mkdtempSync(join(tmpdir(), "dd-state-"));
      try {
        mkdirSync(join(ws, ".gate"), { recursive: true });
        writeFileSync(join(ws, SENTINEL_REL), "ok"); // gate-passed
        const md = join(ws, "supabase", "migrations");
        mkdirSync(md, { recursive: true });
        writeFileSync(
          join(md, "001_init.sql"),
          `create table if not exists ${TABLE} (id uuid primary key default gen_random_uuid(), owner uuid, secret text);\nalter table ${TABLE} enable row level security;\ncreate policy "owner_only" on ${TABLE} for select using (auth.uid() = owner);`,
        );

        const captured: { hostEnv?: Record<string, string> } = {};
        const fakeHost: HostProvider = {
          name: "fake",
          deploy: async (_w, env) => {
            captured.hostEnv = env;
            return { url: "https://dd-e2e.fake.vercel.app", hostRef: "dd-e2e" };
          },
          teardown: async () => {},
        };
        const deps: SubstrateDeps = {
          backend: new SupabaseBackendProvider(),
          host: fakeHost,
          secrets: new LocalEncryptedSecretsStore(join(stateDir, "secrets"), process.env.VIBEHARD_SECRETS_KEY!),
          records: new FileRecordStore(join(stateDir, "deployments")),
        };

        const outcome = await deployApp(ws, { app: "dd-e2e-app", deps });
        expect(outcome.live).toBe(true);
        expect(outcome.url).toBe("https://dd-e2e.fake.vercel.app");
        // §16/R6: only url + anon reached the host; the service-role key NEVER did
        const vals = Object.values(captured.hostEnv ?? {});
        expect(vals).not.toContain(process.env.SUPABASE_SERVICE_ROLE_KEY);
        expect(vals.every((v) => v === process.env.SUPABASE_URL || v === process.env.SUPABASE_ANON_KEY)).toBe(true);
        expect(captured.hostEnv?.NEXT_PUBLIC_SUPABASE_URL).toBe(process.env.SUPABASE_URL);

        // the migration really ran on live Supabase
        const db = new SQL(resolveDbUrl(envFrom()));
        try {
          const rows = (await db.unsafe(`select count(*)::int as n from information_schema.tables where table_name='${TABLE}'`)) as Array<{ n: number }>;
          expect(rows[0]!.n).toBe(1);
        } finally {
          await db.end().catch(() => {});
        }

        // the service key is on disk only encrypted — recoverable solely with the passphrase
        const back = await deps.secrets.get("dd-e2e-app");
        expect(back?.serviceKey).toBe(process.env.SUPABASE_SERVICE_ROLE_KEY);
      } finally {
        rmSync(ws, { recursive: true, force: true });
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
    120000,
  );
});
