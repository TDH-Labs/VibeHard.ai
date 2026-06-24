/**
 * LIVE Tier-0 spike — proves verifyLiveRls against a REAL Supabase project. It creates
 * two probe tables (one RLS-OFF = the CVE-2025-48757 mistake, one RLS-ON), seeds a canary
 * row in each, then fires the anonymous probe and asserts it FLAGS the leaky table and
 * CLEARS the protected one. This is the differentiated guarantee, demonstrated end-to-end.
 *
 * GUARDED: mutates the DB (creates/seeds/drops `_vibehard_probe_*`), so it runs only with
 * VIBEHARD_INTEGRATION=1 and the Supabase creds present. Teardown drops the probe tables.
 *
 *   VIBEHARD_INTEGRATION=1 bun test src/substrate/supabase.integration.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { resolveDbUrl, SupabaseBackendProvider, type SupabaseEnv } from "./supabase.ts";

const RUN =
  !!process.env.VIBEHARD_INTEGRATION &&
  !!process.env.SUPABASE_URL &&
  !!process.env.SUPABASE_ANON_KEY &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
  (!!process.env.SUPABASE_DB_PASSWORD || !!process.env.SUPABASE_DB_URL);

const maybe = RUN ? test : test.skip;
const OPEN = "_vibehard_probe_open";
const SECURE = "_vibehard_probe_secure";

// Faithful CVE-2025-48757 reproduction. Supabase now AUTO-ENABLES RLS on new tables, so
// the real leak isn't "no RLS" — it's a permissive policy. OPEN has RLS on but a
// `using (true)` policy (the "I added RLS" trap) → it leaks every row to anon. SECURE has
// RLS on with NO permissive policy → anon is denied. Both granted to anon (Supabase default).
const SETUP_SQL = `
drop table if exists ${OPEN};
drop table if exists ${SECURE};
create table ${OPEN} (id int primary key, secret text);
create table ${SECURE} (id int primary key, secret text);
alter table ${OPEN} enable row level security;
create policy "leaky_all" on ${OPEN} for select using (true);
alter table ${SECURE} enable row level security;
grant usage on schema public to anon;
grant select on ${OPEN} to anon;
grant select on ${SECURE} to anon;
insert into ${OPEN} values (1, 'leaked-canary');
insert into ${SECURE} values (1, 'protected-canary');
notify pgrst, 'reload schema';
`;

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

/** Wait for PostgREST to pick up the new tables (schema-cache reload after DDL). */
async function waitForRest(env: SupabaseEnv, table: string, timeoutMs = 20000): Promise<boolean> {
  const url = `${env.url}/rest/v1/${table}?select=id&limit=1`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}` } });
    if (res.status !== 404) return true; // table is now visible to PostgREST
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

afterAll(async () => {
  if (!RUN) return;
  const db = new SQL(resolveDbUrl(envFrom()));
  try {
    await db.unsafe(`drop table if exists ${OPEN}; drop table if exists ${SECURE}; notify pgrst, 'reload schema';`).simple();
  } finally {
    await db.end().catch(() => {});
  }
});

describe("LIVE Tier-0 spike — verifyLiveRls against a real Supabase project", () => {
  maybe(
    "migration applies, then the probe FLAGS the RLS-off table and CLEARS the protected one",
    async () => {
      const env = envFrom();
      const provider = new SupabaseBackendProvider({ env });
      const handle = { projectRef: "spike" };

      const mig = await provider.applyMigrations(handle, [{ id: "probe-setup", sql: SETUP_SQL }], []);
      expect(mig.ok).toBe(true);

      expect(await waitForRest(env, SECURE)).toBe(true);
      expect(await waitForRest(env, OPEN)).toBe(true);

      // THE PROOF: the unprotected table leaks to anon; the RLS-protected one does not.
      const result = await provider.verifyLiveRls(handle, [OPEN, SECURE]);
      expect(result.leakedTables).toEqual([OPEN]);
      expect(result.enforced).toBe(false);

      const secureOnly = await provider.verifyLiveRls(handle, [SECURE]);
      expect(secureOnly).toEqual({ enforced: true, leakedTables: [] });
    },
    60000,
  );
});
