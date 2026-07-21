import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMigrations, fastPreCheck, scanForStrayMarkers, typecheckOnly } from "./fast-checks.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-fastcheck-"));
  dirs.push(d);
  return d;
}
function write(ws: string, rel: string, content: string): void {
  const abs = join(ws, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("scanForStrayMarkers — the CDATA-marker incident's regression lock, generalized", () => {
  test("flags a lone trailing ']]>' — exactly the shape the live incident took", () => {
    write(workspace(), "app/page.tsx", "export default function Page() {\n  return null\n}\n]]>");
    const ws = dirs[dirs.length - 1]!;
    const findings = scanForStrayMarkers(ws);
    expect(findings.some((f) => f.message.includes("]]>"))).toBe(true);
  });
  test("flags a lone leading '<![CDATA['", () => {
    const ws = workspace();
    write(ws, "app/page.tsx", "<![CDATA[\nexport default function Page() {}\n");
    expect(scanForStrayMarkers(ws).some((f) => f.message.includes("CDATA"))).toBe(true);
  });
  test("flags a leaked <boltAction>/<boltArtifact> protocol tag", () => {
    const ws = workspace();
    write(ws, "app/page.tsx", "export default function Page() {}\n<boltAction type=\"file\">\n");
    expect(scanForStrayMarkers(ws).some((f) => f.message.includes("bolt"))).toBe(true);
  });
  test("does NOT flag ']]>' embedded mid-line in real code (a string literal, not a stray marker)", () => {
    const ws = workspace();
    write(ws, "lib/xml.ts", 'export const marker = "]]>";\nexport const after = 1;\n');
    expect(scanForStrayMarkers(ws)).toEqual([]);
  });
  test("flags an odd number of markdown fences (a truncated response)", () => {
    const ws = workspace();
    write(ws, "lib/util.ts", "export function f() {\n```\n  return 1;\n}\n");
    expect(scanForStrayMarkers(ws).some((f) => f.message.includes("fence"))).toBe(true);
  });
  test("a matched pair of fences is NOT flagged", () => {
    const ws = workspace();
    write(ws, "README.md", "# Title\n```ts\nconst x = 1;\n```\n");
    expect(scanForStrayMarkers(ws)).toEqual([]);
  });
  test("node_modules and other derived dirs are never scanned", () => {
    const ws = workspace();
    write(ws, "node_modules/pkg/index.js", "]]>"); // would flag if scanned
    expect(scanForStrayMarkers(ws)).toEqual([]);
  });
});

describe("typecheckOnly — the largest class of build failure, caught in seconds not minutes", () => {
  test("no tsconfig.json → passed (not every generated stack is TypeScript)", async () => {
    const ws = workspace();
    expect(await typecheckOnly(ws)).toEqual({ passed: true, findings: [] });
  });
  test("valid TypeScript → passed", async () => {
    const ws = workspace();
    write(ws, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022" } }));
    write(ws, "index.ts", "export const x: number = 1;\n");
    const r = await typecheckOnly(ws);
    expect(r.passed).toBe(true);
  }, 20_000);
  test("a real type error is caught and reported per-diagnostic", async () => {
    const ws = workspace();
    write(ws, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022" } }));
    write(ws, "index.ts", 'export const x: number = "not a number";\n');
    const r = await typecheckOnly(ws);
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.check === "typecheck" && /TS2322/.test(f.message))).toBe(true);
  }, 20_000);
});

describe("checkMigrations — the 'teams is not a view' incident, caught in milliseconds via embedded Postgres", () => {
  test("no supabase/migrations dir → passed", async () => {
    expect(await checkMigrations(workspace())).toEqual({ passed: true, findings: [] });
  });
  test("valid sequential migrations → passed", async () => {
    const ws = workspace();
    write(ws, "supabase/migrations/0001_teams.sql", "create table teams (id uuid primary key);");
    write(ws, "supabase/migrations/0002_teams_rls.sql", "alter table teams enable row level security;");
    const r = await checkMigrations(ws);
    expect(r.passed).toBe(true);
  });
  test("a migration treating a TABLE as a VIEW fails exactly like the live incident", async () => {
    const ws = workspace();
    write(ws, "supabase/migrations/0001_teams.sql", "create table teams (id uuid primary key);");
    write(ws, "supabase/migrations/0002_team_alias.sql", "alter view teams rename to team_alias;");
    const r = await checkMigrations(ws);
    expect(r.passed).toBe(false);
    expect(r.findings[0]!.check).toBe("migration-ddl");
    expect(r.findings[0]!.file).toContain("0002_team_alias.sql");
  });
  test("a syntactically invalid migration is caught, not silently ignored", async () => {
    const ws = workspace();
    write(ws, "supabase/migrations/0001_bad.sql", "creaet table oops (id uuid);"); // typo'd keyword
    const r = await checkMigrations(ws);
    expect(r.passed).toBe(false);
  });
});

describe("fastPreCheck — aggregates all three, runs before the real (expensive) gate chain", () => {
  test("a clean workspace passes", async () => {
    const ws = workspace();
    write(ws, "app.ts", "export const ok = 1;\n");
    const r = await fastPreCheck(ws);
    expect(r).toEqual({ passed: true, findings: [] });
  });
  test("a stray marker alone is enough to fail, without needing a tsconfig or migrations", async () => {
    const ws = workspace();
    write(ws, "app.ts", "export const ok = 1;\n]]>");
    const r = await fastPreCheck(ws);
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.check === "stray-marker")).toBe(true);
  });
});
