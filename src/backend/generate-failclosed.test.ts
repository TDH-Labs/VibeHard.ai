import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceDataModel } from "./model.ts";
import { generateBackend } from "./generate.ts";
import { runRlsEnforcement } from "../gate/rls-enforce.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function project(): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-failclosed-"));
  tmps.push(d);
  mkdirSync(join(d, "supabase"), { recursive: true });
  return d;
}

describe("generator fail-closed defaults (A3)", () => {
  test("an unspecified/invalid access defaults to tenant-isolated, NOT authenticated-shared", () => {
    const m = coerceDataModel({ entities: [{ name: "Thing", fields: [{ name: "x", type: "text" }] }] });
    expect(m.entities[0]!.access).toBe("tenant"); // was "auth" (every logged-in user, any tenant)
    const bad = coerceDataModel({ entities: [{ name: "Thing", access: "world", fields: [] }] });
    expect(bad.entities[0]!.access).toBe("tenant");
  });

  test("a multi-tenant table that can't be scoped gets DENY-ALL + a loud warning — never authenticated-only", async () => {
    const model = coerceDataModel({
      tenantEntity: "Org",
      membershipEntity: "Member",
      tenantField: "orgId",
      roleField: "role",
      adminRole: "admin",
      entities: [
        { name: "Org", access: "tenant-admin", fields: [{ name: "name", type: "text" }] },
        { name: "Member", access: "owner", fields: [{ name: "email", type: "text" }, { name: "orgId", type: "uuid", references: "Org" }] },
        // a feature table with NO owner link and NO tenant column → unscopable
        { name: "Secret", access: "owner", fields: [{ name: "value", type: "text" }] },
      ],
    });
    const dir = project();
    const r = generateBackend(dir, model);
    expect(r.warnings.some((w) => /Secret/.test(w))).toBe(true); // loud, not silent
    const rls = readFileSync(join(dir, "supabase/migrations/0003_rls.sql"), "utf8");
    expect(rls).toContain(`create policy "Secret_deny" on "Secret" for all using (false) with check (false)`);
    expect(rls).not.toMatch(/on "Secret".*auth\.uid\(\) is not null/); // the old fail-open is gone
    // and the deny policy is SAFE: enforcement confirms no cross-tenant or anon access to Secret
    const v = await runRlsEnforcement(dir, model);
    expect(v.status).toBe("pass");
  });

  test("a SINGLE-tenant model (no membership table) keeps authenticated-shared — one tenant, no leak", () => {
    const single = coerceDataModel({ entities: [{ name: "Item", access: "tenant", fields: [{ name: "x", type: "text" }] }] });
    const dir = project();
    const r = generateBackend(dir, single);
    const rls = readFileSync(join(dir, "supabase/migrations/0003_rls.sql"), "utf8");
    expect(rls).toContain(`create policy "Item_auth_all" on "Item" for all using (auth.uid() is not null)`);
    expect(r.warnings.length).toBe(0); // not a deny — there is no second tenant to isolate from
  });

  test("every owner/tenant FOR ALL policy carries an explicit WITH CHECK (write scope = read scope)", () => {
    const model = coerceDataModel({
      tenantEntity: "Org",
      membershipEntity: "Member",
      tenantField: "orgId",
      roleField: "role",
      adminRole: "admin",
      entities: [
        { name: "Org", access: "tenant-admin", fields: [{ name: "name", type: "text" }] },
        { name: "Member", access: "owner", fields: [{ name: "orgId", type: "uuid", references: "Org" }] },
        { name: "Project", access: "tenant", fields: [{ name: "orgId", type: "uuid", references: "Org" }] },
      ],
    });
    const dir = project();
    generateBackend(dir, model);
    const rls = readFileSync(join(dir, "supabase/migrations/0003_rls.sql"), "utf8");
    for (const m of rls.matchAll(/create policy "[^"]+" on "[^"]+" for all using \(([^)]*(?:\([^)]*\))?[^)]*)\)/g)) {
      // each FOR ALL must be followed by a with check on the same statement
      const stmt = rls.slice(m.index, rls.indexOf(";", m.index));
      expect(stmt).toMatch(/with check/);
    }
  });
});
