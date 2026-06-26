import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceDataModel } from "./model.ts";
import { generateBackend } from "./generate.ts";
import { SUPABASE_STUBS, neutralize } from "../gate/migrate.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const MODEL = coerceDataModel({
  tenantEntity: "Org",
  membershipEntity: "Member",
  tenantField: "orgId",
  roleField: "role",
  adminRole: "admin",
  entities: [
    { name: "Org", access: "tenant-admin", fields: [{ name: "name", type: "text" }] },
    { name: "Member", access: "owner", fields: [{ name: "email", type: "text" }, { name: "orgId", type: "uuid", references: "Org" }] },
  ],
});

async function bootDb() {
  const dir = mkdtempSync(join(tmpdir(), "vibehard-bootstrap-"));
  tmps.push(dir);
  mkdirSync(join(dir, "supabase"), { recursive: true });
  generateBackend(dir, MODEL);
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  const mdir = join(dir, "supabase/migrations");
  for (const f of readdirSync(mdir).filter((x) => x.endsWith(".sql")).sort()) await db.exec(neutralize(readFileSync(join(mdir, f), "utf8")));
  // a victim tenant B already exists
  await db.exec(`insert into "Org" ("id", "name") values ('${TENANT_B}', 'Victim Org');`);
  return db;
}

describe("bootstrap trigger — client-supplied metadata can NEVER assign tenant or admin", () => {
  test("a forged signup (raw_user_meta_data.tenantId=B, role=admin) does NOT join tenant B", async () => {
    const db = await bootDb();
    try {
      // The attacker controls raw_user_meta_data via signUp({ data: ... }). They aim themselves at B as admin.
      await db.exec(`insert into auth.users ("id", "email", "raw_user_meta_data", "raw_app_meta_data")
        values ('a0000000-0000-4000-8000-000000000001', 'attacker@evil.test',
                '{"tenantId":"${TENANT_B}","role":"admin"}'::jsonb, '{}'::jsonb);`);
      // The membership exists (they get a usable account) ...
      const mine = await db.query<{ orgId: string; role: string }>(`select "orgId", "role" from "Member" where "authUserId" = 'a0000000-0000-4000-8000-000000000001'`);
      expect(mine.rows.length).toBe(1);
      // ... but it is a FRESH own tenant, NOT the victim's, and never admin of the victim.
      expect((mine.rows[0] as { orgId: string }).orgId).not.toBe(TENANT_B);
      const intoVictim = await db.query<{ n: number }>(`select count(*)::int as n from "Member" where "authUserId" = 'a0000000-0000-4000-8000-000000000001' and "orgId" = '${TENANT_B}'`);
      expect(Number((intoVictim.rows[0] as { n: number }).n)).toBe(0); // the takeover is impossible
    } finally {
      await db.close();
    }
  });

  test("a legitimate server-side invite (raw_app_meta_data) DOES join the named tenant with the given role", async () => {
    const db = await bootDb();
    try {
      // Only the service role can write raw_app_meta_data (e.g. an invite-accept endpoint). This is trusted.
      await db.exec(`insert into auth.users ("id", "email", "raw_user_meta_data", "raw_app_meta_data")
        values ('c0000000-0000-4000-8000-000000000002', 'invited@ok.test',
                '{}'::jsonb, '{"tenantId":"${TENANT_B}","role":"member"}'::jsonb);`);
      const row = await db.query<{ orgId: string; role: string }>(`select "orgId", "role" from "Member" where "authUserId" = 'c0000000-0000-4000-8000-000000000002'`);
      expect(row.rows.length).toBe(1);
      expect((row.rows[0] as { orgId: string; role: string }).orgId).toBe(TENANT_B); // joined the invited tenant
      expect((row.rows[0] as { orgId: string; role: string }).role).toBe("member"); // with the server-set role, not admin
    } finally {
      await db.close();
    }
  });
});
