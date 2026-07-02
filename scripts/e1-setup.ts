#!/usr/bin/env bun
/**
 * E1 setup — provision the live attack scenario against a real Supabase project. Applies the generated
 * migrations, then creates TWO tenants (two self-service signups → the bootstrap trigger gives each its
 * own tenant), and drops one private row into a tenant-scoped table per tenant. After this, run
 * scripts/cross-tenant-attack.ts to prove tenant A cannot read tenant B's row.
 *
 * Reads from the environment (put them in ~/dev/vibehard-e1/.env):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_DB_URL  (the direct Postgres connection string)
 *   optional MIGRATIONS_DIR (default ~/dev/vibehard-e1/supabase/migrations)
 */
import { SQL } from "bun";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`missing required env: ${k}`);
    process.exit(2);
  }
  return v;
};

const SUPABASE_URL = need("SUPABASE_URL").replace(/\/$/, "");
const SERVICE = need("SUPABASE_SERVICE_KEY");
const DB_URL = need("SUPABASE_DB_URL");
const MIG_DIR = process.env.MIGRATIONS_DIR ?? `${process.env.HOME}/dev/vibehard-e1/supabase/migrations`;
const PASSWORD = "E1-Attack-Test-9271!"; // a throwaway password for the two TEST users in this TEST project

async function adminCreateUser(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`create user ${email}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { id: string }).id;
}

const db = new SQL(DB_URL);
try {
  // 1. apply the generated migrations in order.
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    process.stdout.write(`  applying ${f} … `);
    await db.unsafe(readFileSync(join(MIG_DIR, f), "utf8")).simple();
    console.log("ok");
  }

  // 2. two self-service signups → the bootstrap trigger gives EACH its own fresh tenant + admin.
  const ts = Date.now();
  const emailA = `tenant-a-${ts}@e1.test`;
  const emailB = `tenant-b-${ts}@e1.test`;
  const uidA = await adminCreateUser(emailA);
  const uidB = await adminCreateUser(emailB);
  await new Promise((r) => setTimeout(r, 1000)); // let the AFTER-INSERT trigger settle

  // 3. one PRIVATE row per tenant (service role bypasses RLS for seeding) → something to (fail to) cross-read.
  const [aRows, bRows] = await Promise.all([db`select "tenant_id" from "users" where "authUserId" = ${uidA}`, db`select "tenant_id" from "users" where "authUserId" = ${uidB}`]);
  const tenantA = (aRows[0] as { tenant_id: string } | undefined)?.tenant_id;
  const tenantB = (bRows[0] as { tenant_id: string } | undefined)?.tenant_id;
  if (!tenantA || !tenantB) throw new Error("bootstrap did not create a membership/tenant for a user — check the trigger");
  await db`insert into "classes" ("tenant_id", "name") values (${tenantA}, 'Tenant A PRIVATE class')`;
  await db`insert into "classes" ("tenant_id", "name") values (${tenantB}, 'Tenant B PRIVATE class')`;

  // 4. hand the attack script its inputs.
  const creds = `TENANT_A_EMAIL=${emailA}\nTENANT_A_PASSWORD=${PASSWORD}\nTENANT_B_EMAIL=${emailB}\nTENANT_B_PASSWORD=${PASSWORD}\n`;
  writeFileSync(`${process.env.HOME}/dev/vibehard-e1/.e1-creds`, creds);
  console.log(`\n✅ setup done — 2 tenants, each with a private class. Tenant A=${tenantA.slice(0, 8)}…  B=${tenantB.slice(0, 8)}…`);
  console.log(`   test logins written to ~/dev/vibehard-e1/.e1-creds`);
} finally {
  await db.end();
}
