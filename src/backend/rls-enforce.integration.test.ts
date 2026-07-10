/**
 * Cross-package integration: proves gate-check's `runRlsEnforcement` correctly judges REAL SQL
 * produced by VibeHard's own codegen (`generateBackend`), not idealized hand-written fixtures.
 * Moved out of @vibehard/gate-check (2026-07-10 extraction) — the package has no reason to know
 * about VibeHard's specific backend generator; this test belongs where both halves it exercises
 * (VibeHard's codegen + the package's gate) are actually available.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceDataModel } from "./model.ts";
import { generateBackend } from "./generate.ts";
import { runRlsEnforcement } from "@vibehard/gate-check";

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

  test("TEETH (audit2 C-2): an access:'auth' table that carries a tenant column is probed and caught", async () => {
    const dir = project();
    // Salary is mislabeled access:"auth" but carries orgId → tenant data readable by ANY authenticated
    // user of ANY tenant. The old harness skipped non-owner/tenant access classes; now it must catch this.
    const model = coerceDataModel({
      tenantEntity: "Org",
      membershipEntity: "Member",
      tenantField: "orgId",
      roleField: "role",
      adminRole: "admin",
      entities: [
        { name: "Org", access: "tenant-admin", fields: [{ name: "name", type: "text" }] },
        { name: "Member", access: "owner", fields: [{ name: "email", type: "text" }, { name: "orgId", type: "uuid", references: "Org" }] },
        { name: "Salary", access: "auth", fields: [{ name: "amount", type: "integer" }, { name: "orgId", type: "uuid", references: "Org" }] },
      ],
    });
    generateBackend(dir, model);
    const v = await runRlsEnforcement(dir, model);
    expect(v.status).toBe("block");
    expect(v.findings.some((f) => f.ruleId === "cross-tenant-read" && /Salary/.test(f.message))).toBe(true);
    expect(v.findings.some((f) => /access:"auth" but carries a tenant column/.test(f.message))).toBe(true);
  });

  test("TEETH (audit3 M-5): an access:'auth' table with a per-user owner column (no tenant column) is caught", async () => {
    const dir = project();
    // Notification is access:"auth" with authUserId but NO tenant column → any authenticated user can
    // read any other user's notifications. The C-2 probe only covered tenant-column tables; M-5 adds this.
    const model = coerceDataModel({
      tenantEntity: "Org",
      membershipEntity: "Member",
      tenantField: "orgId",
      roleField: "role",
      adminRole: "admin",
      entities: [
        { name: "Org", access: "tenant-admin", fields: [{ name: "name", type: "text" }] },
        { name: "Member", access: "owner", fields: [{ name: "email", type: "text" }, { name: "orgId", type: "uuid", references: "Org" }] },
        { name: "Notification", access: "auth", fields: [{ name: "body", type: "text" }, { name: "authUserId", type: "uuid" }] },
      ],
    });
    generateBackend(dir, model);
    const v = await runRlsEnforcement(dir, model);
    expect(v.status).toBe("block");
    expect(v.findings.some((f) => f.ruleId === "cross-tenant-read" && /Notification/.test(f.message))).toBe(true);
    expect(v.findings.some((f) => /per-user owner column/.test(f.message))).toBe(true);
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
