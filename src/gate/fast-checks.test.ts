import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  test("checks against the WORKSPACE's own declared typescript version, not whatever bunx resolves to bare (2026-07-22, real live block: npm's 'latest' typescript removed the baseUrl option — TS5102 — false-failing the golden template's valid tsconfig.json before any install ever ran)", async () => {
    const ws = workspace();
    write(ws, "package.json", JSON.stringify({ devDependencies: { typescript: "5.7.3" } }));
    write(ws, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022", baseUrl: ".", paths: { "@/*": ["./*"] } } }));
    write(ws, "index.ts", "export const x: number = 1;\n");
    const r = await typecheckOnly(ws);
    expect(r).toEqual({ passed: true, findings: [] });
  }, 30_000);

  test("an app importing external packages (react, next) does NOT false-positive with 'Cannot find module' (2026-07-23, real live escalation: EVERY generated app imports react/next — with no install at all, every single import failed, not just JSX)", async () => {
    const ws = workspace();
    write(ws, "package.json", JSON.stringify({ dependencies: { react: "19.0.0", "react-dom": "19.0.0", next: "15.5.20" }, devDependencies: { typescript: "5.7.3", "@types/node": "22.10.5", "@types/react": "19.0.6" } }));
    write(ws, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022", jsx: "preserve" }, include: ["**/*.ts", "**/*.tsx"] }));
    write(ws, "app/page.tsx", "import { useState } from 'react';\nimport Link from 'next/link';\nexport default function Page() {\n  const [n] = useState(0);\n  return <div><Link href=\"/x\">{n}</Link></div>;\n}\n");
    const r = await typecheckOnly(ws);
    expect(r).toEqual({ passed: true, findings: [] });
  }, 60_000);

  test("a malformed/unresolvable typescript version in package.json is reported as an install failure (2026-07-23: ensureDepsForTypecheck now runs a REAL npm install first, so npm itself refuses this before typecheck ever runs)", async () => {
    const ws = workspace();
    write(ws, "package.json", JSON.stringify({ devDependencies: { typescript: "git+https://evil.example/x.git" } }));
    write(ws, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022", baseUrl: ".", paths: { "@/*": ["./*"] } } }));
    write(ws, "index.ts", "export const x: number = 1;\n");
    const r = await typecheckOnly(ws);
    expect(r.passed).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.file).toBe("package.json");
    expect(r.findings[0]?.message).toContain("npm install");
  }, 30_000);

  test("the bunx typescript-version pin still sanitizes an unsafe value when node_modules is already satisfied (install skipped, so the bad value never reaches a real npm call)", async () => {
    const ws = workspace();
    write(ws, "package.json", JSON.stringify({ devDependencies: { typescript: "git+https://evil.example/x.git" } }));
    write(ws, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022", baseUrl: ".", paths: { "@/*": ["./*"] } } }));
    write(ws, "index.ts", "export const x: number = 1;\n");
    // Fake an already-satisfied install so ensureDepsForTypecheck's installStale() sees nothing to
    // do — installStale() checks each declared dep exists + a stamp file newer than package.json.
    mkdirSync(join(ws, "node_modules/typescript"), { recursive: true });
    writeFileSync(join(ws, "node_modules/.package-lock.json"), "{}");
    const r = await typecheckOnly(ws);
    expect(r).toEqual({ passed: true, findings: [] }); // fell back to the safe pin, baseUrl still resolves fine
  }, 30_000);

  test("a .tsx file using JSX does NOT false-positive with 'no interface JSX.IntrinsicElements exists' (2026-07-22, real live escalation: every generated Next.js app is a .tsx file, and there's no @types/react to resolve — this runs before any install)", async () => {
    const ws = workspace();
    write(ws, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022", jsx: "preserve" }, include: ["**/*.ts", "**/*.tsx"] }));
    write(ws, "app/dashboard/page.tsx", "export default function Page() {\n  return <div><h1>hi</h1></div>;\n}\n");
    const r = await typecheckOnly(ws);
    expect(r).toEqual({ passed: true, findings: [] });
  }, 30_000);

  test("a REAL type error in a .tsx file still surfaces — the JSX stub doesn't swallow unrelated bugs", async () => {
    const ws = workspace();
    write(ws, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022", jsx: "preserve" }, include: ["**/*.ts", "**/*.tsx"] }));
    write(ws, "app/dashboard/page.tsx", 'export const x: number = "not a number";\nexport default function Page() {\n  return <div><h1>hi</h1></div>;\n}\n');
    const r = await typecheckOnly(ws);
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.check === "typecheck" && /TS2322/.test(f.message))).toBe(true);
    expect(r.findings.some((f) => /IntrinsicElements/.test(f.message))).toBe(false);
  }, 30_000);

  test("the JSX stub file never leaks into the workspace after the check runs", async () => {
    const ws = workspace();
    write(ws, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022", jsx: "preserve" }, include: ["**/*.ts", "**/*.tsx"] }));
    write(ws, "app/dashboard/page.tsx", "export default function Page() {\n  return <div>hi</div>;\n}\n");
    await typecheckOnly(ws);
    const leaked = readdirSync(ws).some((n) => n.includes("jsx-stub"));
    expect(leaked).toBe(false);
  }, 30_000);
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
  test("a standard Supabase RLS policy using auth.uid() passes — NOT a false positive", async () => {
    // Found live (2026-07-21, this check's first live smoke test): a bare pglite has no `auth`
    // schema, so this exact standard, CORRECT Supabase pattern failed with "schema auth does not
    // exist" until checkMigrations was seeded with the real migrate gate's SUPABASE_STUBS.
    const ws = workspace();
    write(ws, "supabase/migrations/0001_tasks.sql", 'create table "tasks" (id uuid primary key default gen_random_uuid(), user_id uuid not null);');
    write(
      ws,
      "supabase/migrations/0002_rls.sql",
      'alter table "tasks" enable row level security;\ncreate policy "tasks_own_rows" on "tasks" for all using (auth.uid() = user_id) with check (auth.uid() = user_id);',
    );
    const r = await checkMigrations(ws);
    expect(r).toEqual({ passed: true, findings: [] });
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
