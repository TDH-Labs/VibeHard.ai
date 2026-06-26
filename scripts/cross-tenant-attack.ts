#!/usr/bin/env bun
/**
 * E1 — the LIVE cross-tenant attack (REMEDIATION.md). The production version of the A1 rls-enforce gate:
 * instead of pglite, it runs against a DEPLOYED app's real Supabase REST API. Two real users in two
 * different tenants sign in; the script asserts their visible row-sets are DISJOINT (neither sees the
 * other's data) and that an anonymous caller sees nothing. Any overlap is a tenant-isolation breach.
 *
 * This is the pipeline's acceptance test: "the database refuses the attack in production", not "the
 * policy text looks right". Exits non-zero on any leak, so it drops straight into CI.
 *
 * Setup (the user provides — none of this is secret to VibeHard):
 *   1. Deploy a generated app; run its scripts/seed.ts (or sign up) so TWO tenants exist.
 *   2. Create one test user in each tenant.
 *   3. export SUPABASE_URL, SUPABASE_ANON_KEY,
 *             TENANT_A_EMAIL, TENANT_A_PASSWORD, TENANT_B_EMAIL, TENANT_B_PASSWORD
 *      Optionally TABLES="classes,bookings,members" (else read from .vibehard/datamodel.json).
 *   4. bun scripts/cross-tenant-attack.ts [path-to-app]
 */
import { existsSync, readFileSync } from "node:fs";
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
const ANON = need("SUPABASE_ANON_KEY");

/** Sign a user in; return their access token (a tenant-scoped JWT) or throw. */
async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status} ${(await res.text()).slice(0, 160)}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`no access_token for ${email}`);
  return body.access_token;
}

/** The set of row ids a caller (token, or anon when token is null) can read from a table. */
async function visibleIds(table: string, token: string | null): Promise<Set<string>> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?select=id`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token ?? ANON}` },
  });
  if (res.status === 401 || res.status === 403) return new Set(); // denied → sees nothing
  if (!res.ok) throw new Error(`query ${table} failed: ${res.status}`);
  const rows = (await res.json()) as Array<{ id?: string }>;
  return new Set(rows.map((r) => String(r.id)).filter((x) => x !== "undefined"));
}

function tablesFor(appPath: string): string[] {
  if (process.env.TABLES) return process.env.TABLES.split(",").map((s) => s.trim()).filter(Boolean);
  const modelPath = join(appPath, ".vibehard", "datamodel.json");
  if (existsSync(modelPath)) {
    try {
      const m = JSON.parse(readFileSync(modelPath, "utf8")) as { entities?: Array<{ name: string; access?: string }> };
      // probe everything that isn't world-readable by design
      return (m.entities ?? []).filter((e) => e.access !== "public").map((e) => e.name);
    } catch {
      /* fall through */
    }
  }
  console.error("no TABLES env and no .vibehard/datamodel.json — pass TABLES=a,b,c");
  process.exit(2);
}

async function main() {
  const appPath = process.argv[2] ?? ".";
  const tables = tablesFor(appPath);
  console.log(`cross-tenant attack against ${SUPABASE_URL} over ${tables.length} table(s): ${tables.join(", ")}\n`);

  const tokenA = await signIn(need("TENANT_A_EMAIL"), need("TENANT_A_PASSWORD"));
  const tokenB = await signIn(need("TENANT_B_EMAIL"), need("TENANT_B_PASSWORD"));

  const leaks: string[] = [];
  for (const t of tables) {
    const [a, b, anon] = await Promise.all([visibleIds(t, tokenA), visibleIds(t, tokenB), visibleIds(t, null)]);
    const shared = [...a].filter((id) => b.has(id)); // a tenant-A user seeing a tenant-B row (or vice versa)
    const before = leaks.length;
    if (shared.length) leaks.push(`${t}: tenants A and B BOTH see row(s) ${shared.slice(0, 3).join(", ")} — cross-tenant leak`);
    if (anon.size) leaks.push(`${t}: an ANONYMOUS caller can read ${anon.size} row(s) — public exposure (CVE-2025-48757 class)`);
    console.log(`  ${leaks.length > before ? "✗" : "✓"} ${t.padEnd(24)} A=${a.size} B=${b.size} anon=${anon.size}`);
  }

  console.log("");
  if (leaks.length) {
    console.error(`TENANT ISOLATION FAILED — ${leaks.length} leak(s):`);
    for (const l of leaks) console.error(`  • ${l}`);
    process.exit(1);
  }
  console.log("✅ tenant isolation HOLDS in production — no cross-tenant or anonymous read on any probed table.");
}

main().catch((e) => {
  console.error(`attack harness error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
