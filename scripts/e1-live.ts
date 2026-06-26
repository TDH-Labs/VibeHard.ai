#!/usr/bin/env bun
/**
 * E1 live runner — apply the generated backend to a REAL Supabase project, seed two tenants, and run
 * the cross-tenant attack against the live REST API. The production acceptance test (REMEDIATION.md E1):
 * "the database refuses the attack in production", proven 2026-06-26 against a throwaway project — every
 * tenant-scoped table showed each tenant seeing ONLY its own row, zero overlap, anon nothing.
 *
 * Uses Supabase's Management API query endpoint for DDL (no DB connection string / pooler needed), the
 * Auth admin API for the two test users, and anon sign-ins for the attack. Reads from env:
 *   SUPABASE_PAT  (Management API token), SUPABASE_PROJECT_REF, SUPABASE_URL, SUPABASE_ANON_KEY,
 *   SUPABASE_SERVICE_KEY, and MIGRATIONS_DIR (default ~/dev/vibehard-e1/supabase/migrations).
 * Exits non-zero on any cross-tenant or anonymous read → CI-able.
 */
import { readFileSync } from "node:fs";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`missing env: ${k}`);
    process.exit(2);
  }
  return v;
};
const PAT = need("SUPABASE_PAT");
const REF = need("SUPABASE_PROJECT_REF");
const URL = need("SUPABASE_URL").replace(/\/$/, "");
const ANON = need("SUPABASE_ANON_KEY");
const SERVICE = need("SUPABASE_SERVICE_KEY");
const MIG_DIR = process.env.MIGRATIONS_DIR ?? `${process.env.HOME}/dev/vibehard-e1/supabase/migrations`;
const PASS = "E1-Attack-Test-9271!";

const mgmt = { Authorization: `Bearer ${PAT}`, "content-type": "application/json" };
async function runSql(query: string): Promise<Array<Record<string, unknown>>> {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: "POST", headers: mgmt, body: JSON.stringify({ query }) });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as Array<Record<string, unknown>>;
}
async function mkUser(email: string): Promise<string> {
  const r = await fetch(`${URL}/auth/v1/admin/users`, { method: "POST", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASS, email_confirm: true }) });
  if (!r.ok) throw new Error(`mkUser ${email}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as { id: string }).id;
}
async function signIn(email: string): Promise<string> {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASS }) });
  if (!r.ok) throw new Error(`signin ${email}: ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}
async function ids(table: string, token: string | null): Promise<Set<string>> {
  const r = await fetch(`${URL}/rest/v1/${table}?select=id`, { headers: { apikey: ANON, Authorization: `Bearer ${token ?? ANON}` } });
  if (r.status === 401 || r.status === 403) return new Set();
  if (!r.ok) throw new Error(`query ${table}: ${r.status}`);
  return new Set(((await r.json()) as Array<{ id: string }>).map((x) => String(x.id)));
}

// 1. apply the hardened backend.
for (const f of ["0001_init.sql", "0002_auth.sql", "0003_rls.sql"]) {
  process.stdout.write(`  applying ${f} … `);
  await runSql(readFileSync(`${MIG_DIR}/${f}`, "utf8"));
  console.log("ok");
}
// 2. two signups → two tenants (the bootstrap trigger gives each its own).
const ts = Date.now();
const emailA = `tenant-a-${ts}@e1.test`;
const emailB = `tenant-b-${ts}@e1.test`;
const uidA = await mkUser(emailA);
const uidB = await mkUser(emailB);
await new Promise((r) => setTimeout(r, 1500));
const tenantA = (await runSql(`select "tenant_id" from "users" where "authUserId"='${uidA}'`))[0]?.tenant_id as string | undefined;
const tenantB = (await runSql(`select "tenant_id" from "users" where "authUserId"='${uidB}'`))[0]?.tenant_id as string | undefined;
if (!tenantA || !tenantB) throw new Error("bootstrap did not create tenants — check the trigger");
// 3. a private row per tenant.
await runSql(`insert into "classes" ("tenant_id","name") values ('${tenantA}','Tenant A PRIVATE class'),('${tenantB}','Tenant B PRIVATE class')`);

// 4. attack.
const tokA = await signIn(emailA);
const tokB = await signIn(emailB);
const tables = ["tenants", "users", "memberships", "classes", "bookings"];
console.log("\n  TENANT-ISOLATION ATTACK (tenant A's user vs tenant B's data, + anon):");
const leaks: string[] = [];
for (const t of tables) {
  const [a, b, anon] = await Promise.all([ids(t, tokA), ids(t, tokB), ids(t, null)]);
  const shared = [...a].filter((x) => b.has(x));
  const before = leaks.length;
  if (shared.length) leaks.push(`${t}: A and B BOTH see ${shared.length} row(s) — CROSS-TENANT LEAK`);
  if (anon.size) leaks.push(`${t}: anonymous can read ${anon.size} row(s) — PUBLIC EXPOSURE`);
  console.log(`    ${leaks.length > before ? "✗" : "✓"} ${t.padEnd(12)} A sees ${a.size}, B sees ${b.size}, anon sees ${anon.size}`);
}
console.log("");
if (leaks.length) {
  console.error("❌ TENANT ISOLATION FAILED:");
  leaks.forEach((l) => console.error("   • " + l));
  process.exit(1);
}
console.log("✅ TENANT ISOLATION HOLDS IN PRODUCTION — tenant A cannot see tenant B's data; anon sees nothing.");
