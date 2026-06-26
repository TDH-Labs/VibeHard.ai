import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceDataModel, type DataModel } from "./model.ts";
import { generateBackend } from "./generate.ts";
import { generateSeed } from "./seed.ts";
import { generateDashboard } from "./dashboard.ts";
import { runMigrate } from "../gate/migrate.ts";
import { runRls } from "../gate/rls.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function ws(): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-backend-"));
  tmps.push(d);
  mkdirSync(join(d, "supabase"), { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { next: "15", "@supabase/ssr": "^0.5.0", "@supabase/supabase-js": "^2.45.0", tailwindcss: "^3" } }));
  return d;
}

// A representative multi-tenant model: tenant root + membership + tenant/tenant-admin/owner tables + a FK.
const MODEL: DataModel = coerceDataModel({
  tenantEntity: "Center",
  membershipEntity: "Staff",
  tenantField: "centerId",
  roleField: "role",
  adminRole: "admin",
  entities: [
    { name: "Center", access: "tenant", fields: [{ name: "name", type: "text" }] },
    { name: "Staff", access: "tenant-admin", fields: [{ name: "name", type: "text" }, { name: "email", type: "text", unique: true }] },
    { name: "Child", access: "tenant", fields: [{ name: "name", type: "text" }, { name: "centerId", type: "uuid", references: "Center" }, { name: "allergies", type: "text[]", nullable: true }] },
    { name: "Invoice", access: "tenant-admin", fields: [{ name: "amount", type: "numeric" }, { name: "centerId", type: "uuid", references: "Center" }, { name: "childId", type: "uuid", references: "Child" }] },
    { name: "Note", access: "owner", fields: [{ name: "authUserId", type: "uuid" }, { name: "body", type: "text" }] },
  ],
});

describe("coerceDataModel (trust boundary)", () => {
  test("drops invalid entities/fields, validates FK targets, applies defaults", () => {
    const m = coerceDataModel({
      entities: [
        { name: "Good", access: "owner", fields: [{ name: "x", type: "text" }, { name: "ref", references: "Nope" }, { junk: true }] },
        { name: "" }, // dropped
        "garbage", // dropped
      ],
    });
    expect(m.entities).toHaveLength(1);
    const f = m.entities[0]!.fields;
    expect(f.find((x) => x.name === "x")).toBeTruthy();
    expect(f.find((x) => x.name === "ref")!.references).toBeUndefined(); // FK to a non-existent entity dropped
    expect(m.tenantField).toBe("centerId"); // default
    expect(m.adminRole).toBe("admin"); // default
  });
});

describe("generateBackend — deterministic, correct-by-construction", () => {
  test("writes the migrations + client trio + auth route + middleware", () => {
    const dir = ws();
    const r = generateBackend(dir, MODEL);
    for (const f of ["supabase/migrations/0001_init.sql", "supabase/migrations/0002_auth.sql", "supabase/migrations/0003_rls.sql", "lib/supabase/client.ts", "lib/supabase/server.ts", "lib/supabase/admin.ts", "app/api/auth/signin/route.ts", "middleware.ts"]) {
      expect(r.written).toContain(f);
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });

  test("RLS is recursion-safe + uses only valid FOR clauses (the AcmeCare bug classes are absent)", () => {
    const dir = ws();
    generateBackend(dir, MODEL);
    const auth = readFileSync(join(dir, "supabase/migrations/0002_auth.sql"), "utf8");
    const rls = readFileSync(join(dir, "supabase/migrations/0003_rls.sql"), "utf8");
    // every helper that a policy calls is SECURITY DEFINER → no recursion
    expect(auth.match(/security definer/gi)?.length).toBeGreaterThanOrEqual(3);
    // never the invalid multi-command FOR clause
    expect(rls).not.toMatch(/for\s+(insert|update|delete|select)\s+(insert|update|delete)/i);
    // only `for all` / `for select`
    expect(rls).toMatch(/for all using .* with check/i);
    // no using(true) except an explicit public policy (none in this model)
    expect(rls).not.toMatch(/using \(true\)/i);
    expect(rls).toContain("enable row level security");
  });

  test("tables are emitted in FK-dependency order (no forward references)", () => {
    const dir = ws();
    generateBackend(dir, MODEL);
    const init = readFileSync(join(dir, "supabase/migrations/0001_init.sql"), "utf8");
    const pos = (t: string) => init.indexOf(`create table if not exists "${t}"`);
    expect(pos("Center")).toBeLessThan(pos("Child")); // Child → Center
    expect(pos("Child")).toBeLessThan(pos("Invoice")); // Invoice → Child
  });

  test("PROOF: generated migrations APPLY clean through the migrate gate (real pglite)", async () => {
    const dir = ws();
    generateBackend(dir, MODEL);
    const v = await runMigrate(dir);
    expect(v.status).toBe("pass"); // applies to a real Postgres with zero findings
    expect(v.findings).toHaveLength(0);
  });

  test("PROOF: the rls gate passes (no using(true), service-key admin-only)", async () => {
    const dir = ws();
    generateBackend(dir, MODEL);
    const v = await runRls(dir);
    expect(v.status).toBe("pass");
  });

  test("seed: FK-aware demo data — tenant + admin login + rows in dependency order", () => {
    const dir = ws();
    const r = generateSeed(dir, MODEL);
    expect(r.written).toBe(true);
    const s = readFileSync(join(dir, "scripts/seed.ts"), "utf8");
    expect(s).toContain("auth.admin.createUser"); // a demo login
    expect(s).toContain('"Center"'); // the tenant is created
    expect(s).toContain("tenantId"); // tenant FK columns are filled with the tenant id
    expect(s).toContain("pickId("); // other FKs resolve to a seeded parent row
    // Child (referenced by Invoice) is seeded before Invoice
    expect(s.indexOf('insert("Child"')).toBeLessThan(s.indexOf('insert("Invoice"'));
  });

  test("dashboard: an overview page with KPI counts + recent items, from the model", () => {
    const dir = ws();
    const r = generateDashboard(dir, MODEL);
    expect(r.written).toBe(true);
    const p = readFileSync(join(dir, "app/dashboard/page.tsx"), "utf8");
    expect(p).toContain("Good day"); // the at-a-glance header
    expect(p).toContain("count: 'exact'"); // live KPI counts
    expect(p).toContain('"Child"'); // a feature entity (not the tenant/membership table)
    expect(p).not.toContain('from("Center")'); // tenant root isn't a KPI card
    expect(p).toContain("@/lib/supabase/server"); // RLS-scoped queries
  });

  test("generate-then-own: re-run overwrites generated files but never clobbers a user-edited one", () => {
    const dir = ws();
    generateBackend(dir, MODEL);
    // user takes ownership of server.ts (removes the marker), and edits a migration but keeps marker
    const serverPath = join(dir, "lib/supabase/server.ts");
    writeFileSync(serverPath, "// my hand-written client\nexport const mine = true;\n");
    const r2 = generateBackend(dir, MODEL);
    expect(r2.skipped).toContain("lib/supabase/server.ts"); // user-owned → preserved
    expect(readFileSync(serverPath, "utf8")).toContain("my hand-written client");
    expect(r2.written).toContain("supabase/migrations/0001_init.sql"); // still-owned → regenerated
  });
});
