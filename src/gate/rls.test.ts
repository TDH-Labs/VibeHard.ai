import { describe, expect, test } from "bun:test";
import { parseRls } from "./rls.ts";
import { verdictOf } from "../types.ts";

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

describe("rls disposition", () => {
  const ts = "2026-06-20T00:00:00.000Z";
  test("an exposed table forces a block", () => {
    const f = parseRls([{ file: "m.sql", sql: VULN }]);
    const v = verdictOf("rls", f, ts);
    expect(v.status).toBe("block");
    expect(v.blocking).toBe(2);
  });
});
