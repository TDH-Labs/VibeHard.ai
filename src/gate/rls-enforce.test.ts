import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceDataModel } from "../backend/model.ts";
import { generateBackend } from "../backend/generate.ts";
import { runRlsEnforcement } from "./rls-enforce.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function project(): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-enforce-"));
  tmps.push(d);
  mkdirSync(join(d, "supabase"), { recursive: true });
  return d;
}

// A representative multi-tenant model: tenant root, membership, a tenant-scoped table, an owner-scoped
// table owned directly (the membership) and one owned INDIRECTLY through a member FK.
const MODEL = coerceDataModel({
  tenantEntity: "Org",
  membershipEntity: "Member",
  tenantField: "orgId",
  roleField: "role",
  adminRole: "admin",
  entities: [
    { name: "Org", access: "tenant-admin", fields: [{ name: "name", type: "text" }] },
    { name: "Member", access: "owner", fields: [{ name: "email", type: "text" }, { name: "orgId", type: "uuid", references: "Org" }] },
    { name: "Project", access: "tenant", fields: [{ name: "title", type: "text" }, { name: "orgId", type: "uuid", references: "Org" }] },
    { name: "Task", access: "owner", fields: [{ name: "title", type: "text" }, { name: "memberId", type: "uuid", references: "Member" }, { name: "orgId", type: "uuid", references: "Org" }] },
  ],
});

describe("RLS enforcement harness — proves the database actually denies cross-tenant access", () => {
  test("PROOF: a correctly-generated backend isolates every tenant (anon + cross-tenant all denied)", async () => {
    const dir = project();
    generateBackend(dir, MODEL);
    const v = await runRlsEnforcement(dir, MODEL);
    if (v.status !== "pass") console.error("unexpected findings:", JSON.stringify(v.findings, null, 2));
    expect(v.status).toBe("pass");
    expect(v.findings.filter((f) => f.severity === "high").length).toBe(0);
  });

  test("TEETH: it CATCHES a real leak — disabling RLS on one table is reported as a blocking cross-tenant read", async () => {
    const dir = project();
    generateBackend(dir, MODEL);
    // Tamper: a developer (or a gamed fix loop) turns RLS off on Project. The static text gate might
    // not notice; the database does — and so must we.
    const rls = join(dir, "supabase/migrations/0003_rls.sql");
    writeFileSync(rls, readFileSync(rls, "utf8") + `\nalter table "Project" disable row level security;\n`);
    const v = await runRlsEnforcement(dir, MODEL);
    expect(v.status).toBe("block");
    const projectLeaks = v.findings.filter((f) => /Project/.test(f.message));
    expect(projectLeaks.length).toBeGreaterThan(0);
    // anon being able to read Project is exactly the CVE-2025-48757 class
    expect(v.findings.some((f) => f.ruleId === "cross-tenant-anon-read" && /Project/.test(f.message))).toBe(true);
  });

  test("TEETH: a too-broad WITH CHECK (cross-tenant INSERT) is caught", async () => {
    const dir = project();
    generateBackend(dir, MODEL);
    // Tamper: scope READS correctly but leave the WRITE check wide open (`with check (true)`) — reads
    // are isolated, but a user can INSERT rows into ANOTHER tenant. (Note: a USING-only policy is NOT
    // a hole — Postgres defaults WITH CHECK to USING; the real hole is an explicitly broad check.)
    const path = join(dir, "supabase/migrations/0003_rls.sql");
    let sql = readFileSync(path, "utf8");
    sql = sql.replace(/create policy "Project_tenant_all"[^;]*;/, `create policy "Project_tenant_all" on "Project" for all using ("orgId" = auth_tenant_id()) with check (true);`);
    writeFileSync(path, sql);
    const v = await runRlsEnforcement(dir, MODEL);
    expect(v.findings.some((f) => f.ruleId === "cross-tenant-insert" && /Project/.test(f.message))).toBe(true);
  });

  test("fail-CLOSED: a harness/SQL error blocks (never a silent pass)", async () => {
    const dir = project();
    generateBackend(dir, MODEL);
    // Corrupt a migration so it can't apply → the harness must BLOCK, not pass.
    writeFileSync(join(dir, "supabase/migrations/0001_init.sql"), `this is not valid sql;`);
    const v = await runRlsEnforcement(dir, MODEL);
    expect(v.status).toBe("block");
    expect(v.findings.some((f) => f.ruleId === "enforcement-error")).toBe(true);
  });
});
