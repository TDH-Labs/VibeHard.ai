import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createdTables,
  detectSupabaseUsage,
  parseRls,
  parseRlsCoverage,
  pkgUsesSupabase,
  readMigrations,
  rlsEnabledTables,
  runRls,
} from "./rls.ts";
import { verdictOf } from "../types.ts";

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function scratch(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "drydock-rls-"));
  tmps.push(d);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(d, path), content);
  return d;
}

const VULN = `
create table public.profiles (id uuid primary key, ssn text);

create table public.documents (id uuid primary key, owner uuid);
alter table public.documents enable row level security;
create policy "all_documents" on public.documents for select using (true);
`;

const FIXED = `
create table public.profiles (id uuid primary key, ssn text);
alter table public.profiles enable row level security;
create policy "own_profile" on public.profiles for select using (auth.uid() = id);

create table public.documents (id uuid primary key, owner uuid);
alter table public.documents enable row level security;
create policy "own_documents" on public.documents for select using (auth.uid() = owner);
`;

describe("parseRls (pure)", () => {
  test("RLS off → critical; using(true) → high (the CVE-2025-48757 pattern)", () => {
    const f = parseRls([{ file: "supabase/migrations/0001_init.sql", sql: VULN }]);
    expect(f).toHaveLength(2);

    const profiles = f.find((x) => x.message.includes("profiles"));
    expect(profiles).toMatchObject({ tool: "rls", ruleId: "rls-disabled", severity: "critical" });
    expect(profiles?.file).toBe("supabase/migrations/0001_init.sql");
    expect(profiles?.line).toBe(2); // 1-based, leading newline + create on line 2

    const documents = f.find((x) => x.message.includes("documents"));
    expect(documents).toMatchObject({ ruleId: "rls-policy-using-true", severity: "high" });
  });

  test("remediated migrations yield no findings", () => {
    expect(parseRls([{ file: "m.sql", sql: FIXED }])).toEqual([]);
  });

  test("enable can live in a different source than the create table", () => {
    const split = parseRls([
      { file: "0001_tables.sql", sql: "create table public.profiles (id uuid primary key);" },
      { file: "0002_rls.sql", sql: "alter table public.profiles enable row level security; create policy p on public.profiles for select using (auth.uid() = id);" },
    ]);
    expect(split).toEqual([]);
  });

  test("each table is reported once, attributed to where it was created", () => {
    const dup = parseRls([
      { file: "a.sql", sql: "create table public.profiles (id uuid);\ncreate table public.profiles (id uuid);" },
    ]);
    expect(dup).toHaveLength(1);
    expect(dup[0]?.line).toBe(1);
  });

  test("no migrations → no findings", () => {
    expect(parseRls([])).toEqual([]);
  });
});

describe("readMigrations (I/O)", () => {
  test("a project with no supabase/migrations dir yields [] (no DB → nothing to check)", async () => {
    // import.meta.dir has no supabase/migrations — must not throw.
    expect(await readMigrations(join(import.meta.dir, "no-such-project"))).toEqual([]);
  });

  test("reads the remediated fixture's migrations", async () => {
    const sources = await readMigrations(join(import.meta.dir, "..", "..", "fixtures", "remediated"));
    expect(sources.length).toBeGreaterThan(0);
    expect(parseRls(sources)).toEqual([]); // remediated → clean
  });
});

describe("rls disposition", () => {
  const ts = "2026-06-20T00:00:00.000Z";
  test("an exposed table forces a block", () => {
    const f = parseRls([{ file: "m.sql", sql: VULN }]);
    const v = verdictOf("rls", f, ts);
    expect(v.status).toBe("block");
    expect(v.blocking).toBe(2);
  });
});

// ── The fail-closed coverage check (CVE-2025-48757: "RLS not found" ≠ "RLS fine") ──

describe("detectSupabaseUsage (pure)", () => {
  test("finds the import and the queried tables", () => {
    const u = detectSupabaseUsage([
      { file: "src/lib/db.ts", code: "import { createClient } from '@supabase/supabase-js';" },
      { file: "src/pages/Dashboard.tsx", code: "const { data } = await supabase.from('clients').select();" },
      { file: "src/pages/Notes.tsx", code: "supabase.from(\"session_notes\").insert(x)" },
    ]);
    expect(u.usesSupabase).toBe(true);
    expect([...u.tables.keys()].sort()).toEqual(["clients", "session_notes"]);
    expect(u.tables.get("clients")).toMatchObject({ file: "src/pages/Dashboard.tsx" });
  });

  test("a package.json dependency alone confirms Supabase usage", () => {
    const u = detectSupabaseUsage([{ file: "src/a.ts", code: "supabase.from('clients').select()" }], true);
    expect(u.usesSupabase).toBe(true);
    expect([...u.tables.keys()]).toEqual(["clients"]);
  });

  test("does NOT treat .from() as a table query when Supabase isn't present (no false positive)", () => {
    const u = detectSupabaseUsage([{ file: "q.ts", code: "knex.from('users').where('id', 1)" }]);
    expect(u.usesSupabase).toBe(false);
    expect(u.tables.size).toBe(0);
  });
});

describe("parseRlsCoverage (pure, fail-closed)", () => {
  const usage = (tables: string[]) =>
    detectSupabaseUsage(
      tables.map((t, i) => ({ file: `src/p${i}.ts`, code: `supabase.from('${t}').select()` })),
      true,
    );

  test("a queried table with no RLS migration → CRITICAL rls-missing", () => {
    const f = parseRlsCoverage(usage(["clients", "session_notes"]), new Set(), new Set());
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ tool: "rls", ruleId: "rls-missing", severity: "critical" });
    expect(f.every((x) => x.message.includes("CVE-2025-48757"))).toBe(true);
  });

  test("queried tables that ARE rls-enabled → no coverage finding", () => {
    const f = parseRlsCoverage(usage(["clients"]), new Set(["clients"]), new Set(["clients"]));
    expect(f).toEqual([]);
  });

  test("a created-but-unprotected table is left to parseRls (no double-report)", () => {
    // created.has(clients) → coverage defers; parseRls would emit rls-disabled.
    const f = parseRlsCoverage(usage(["clients"]), new Set(), new Set(["clients"]));
    expect(f).toEqual([]);
  });

  test("no Supabase usage → nothing required", () => {
    expect(parseRlsCoverage(detectSupabaseUsage([]), new Set(), new Set())).toEqual([]);
  });
});

describe("runRls end-to-end (§11 fail-closed for rls)", () => {
  const ts = "2026-06-21T00:00:00.000Z";

  test("Supabase app that queries a table but ships NO migration → BLOCK", async () => {
    const dir = await scratch({
      "package.json": JSON.stringify({ dependencies: { "@supabase/supabase-js": "^2.39.0" } }),
      "src/lib/supabaseClient.ts": "import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(url, key);",
      "src/pages/Dashboard.tsx": "const { data } = await supabase.from('clients').select('*');",
    });
    const v = await runRls(dir, ts);
    expect(v.status).toBe("block");
    expect(v.findings.some((f) => f.ruleId === "rls-missing" && f.severity === "critical")).toBe(true);
  });

  test("Supabase app with sound RLS policies for every queried table → PASS", async () => {
    const dir = await scratch({
      "package.json": JSON.stringify({ dependencies: { "@supabase/supabase-js": "^2.39.0" } }),
      "src/lib/supabaseClient.ts": "import { createClient } from '@supabase/supabase-js';",
      "src/pages/Dashboard.tsx": "supabase.from('clients').select('*'); supabase.from('session_notes').select('*');",
      "supabase/migrations/001_init.sql": [
        "create table public.clients (id uuid primary key, therapist_id uuid);",
        "alter table public.clients enable row level security;",
        "create policy own_clients on public.clients for all using (therapist_id = auth.uid());",
        "create table public.session_notes (id uuid primary key, therapist_id uuid);",
        "alter table public.session_notes enable row level security;",
        "create policy own_notes on public.session_notes for all using (therapist_id = auth.uid());",
      ].join("\n"),
    });
    const v = await runRls(dir, ts);
    expect(v.findings).toEqual([]);
    expect(v.status).toBe("pass");
  });

  test("a non-Supabase app with no DB still passes (no false positive)", async () => {
    const dir = await scratch({
      "package.json": JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      "src/App.tsx": "export default function App() { return null; }",
    });
    expect((await runRls(dir, ts)).status).toBe("pass");
  });
});

describe("migration fact extractors (pure)", () => {
  test("rlsEnabledTables and createdTables read across sources", () => {
    const sources = [
      { file: "a.sql", sql: "create table public.clients (id uuid);" },
      { file: "b.sql", sql: "alter table public.clients enable row level security;" },
    ];
    expect([...createdTables(sources)]).toEqual(["clients"]);
    expect([...rlsEnabledTables(sources)]).toEqual(["clients"]);
  });
});

describe("pkgUsesSupabase (I/O)", () => {
  test("true when @supabase/supabase-js is a dependency, false otherwise", async () => {
    const yes = await scratch({ "package.json": JSON.stringify({ dependencies: { "@supabase/supabase-js": "^2" } }) });
    const no = await scratch({ "package.json": JSON.stringify({ dependencies: { express: "^4" } }) });
    expect(pkgUsesSupabase(yes)).toBe(true);
    expect(pkgUsesSupabase(no)).toBe(false);
  });
});
