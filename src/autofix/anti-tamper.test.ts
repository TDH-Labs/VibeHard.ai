import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSurface, tamperReason } from "./anti-tamper.ts";
import { autoFix } from "./autofix.ts";
import { verdictOf, type Finding, type GateVerdict } from "../types.ts";
import type { PipelineResult } from "../gate/index.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function ws(): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-tamper-"));
  tmps.push(d);
  mkdirSync(join(d, "supabase", "migrations"), { recursive: true });
  writeFileSync(join(d, "supabase/migrations/0001_init.sql"), `create table "notes" ("id" uuid primary key);\nalter table "notes" enable row level security;\n`);
  writeFileSync(join(d, "middleware.ts"), "export {};\n");
  return d;
}

const rlsFinding: Finding = { tool: "rls", ruleId: "rls-disabled", severity: "critical", file: "supabase/migrations/0001_init.sql", message: "RLS not enabled on public.notes" };

describe("anti-tamper detection (pure)", () => {
  test("deleting a security file (a migration / middleware) is tampering", () => {
    const dir = ws();
    const before = captureSurface(dir, [rlsFinding]);
    rmSync(join(dir, "supabase/migrations/0001_init.sql"));
    expect(tamperReason(before, captureSurface(dir, [rlsFinding]))).toMatch(/security file was DELETED/i);
  });

  test("dropping a table from the migrations is tampering", () => {
    const dir = ws();
    const before = captureSurface(dir, []);
    writeFileSync(join(dir, "supabase/migrations/0001_init.sql"), `-- table removed to dodge the finding\n`);
    expect(tamperReason(before, captureSurface(dir, []))).toMatch(/table was DROPPED/i);
  });

  test("editing a file in place (same surface) is NOT tampering — that's a real fix", () => {
    const dir = ws();
    const before = captureSurface(dir, [rlsFinding]);
    writeFileSync(join(dir, "supabase/migrations/0001_init.sql"), `create table "notes" ("id" uuid primary key);\nalter table "notes" enable row level security;\ncreate policy p on "notes" for all using ("owner" = auth.uid()) with check ("owner" = auth.uid());\n`);
    expect(tamperReason(before, captureSurface(dir, [rlsFinding]))).toBeNull();
  });

  test("adding surface (a new table/file) is never tampering", () => {
    const dir = ws();
    const before = captureSurface(dir, []);
    writeFileSync(join(dir, "supabase/migrations/0002_more.sql"), `create table "extra" ("id" uuid primary key);\n`);
    expect(tamperReason(before, captureSurface(dir, []))).toBeNull();
  });
});

describe("anti-tamper — audit2 B-1 walk-arounds", () => {
  test("deleting .vibehard/datamodel.json (disarms rls-enforce → n/a) is tampering", () => {
    const dir = ws();
    mkdirSync(join(dir, ".vibehard"), { recursive: true });
    writeFileSync(join(dir, ".vibehard/datamodel.json"), `{"tables":[]}`);
    const before = captureSurface(dir, []);
    rmSync(join(dir, ".vibehard/datamodel.json"));
    expect(tamperReason(before, captureSurface(dir, []))).toMatch(/gate INPUT was DELETED/i);
  });

  test("disabling RLS in place (file kept) is tampering", () => {
    const dir = ws();
    const before = captureSurface(dir, []);
    // keep the table + file, but strip the `enable row level security` line
    writeFileSync(join(dir, "supabase/migrations/0001_init.sql"), `create table "notes" ("id" uuid primary key);\n`);
    expect(tamperReason(before, captureSurface(dir, []))).toMatch(/RLS was DISABLED/i);
  });

  test("removing a policy in place is tampering", () => {
    const dir = ws();
    writeFileSync(join(dir, "supabase/migrations/0001_init.sql"), `create table "notes" ("id" uuid primary key);\nalter table "notes" enable row level security;\ncreate policy p on "notes" for all using ("owner" = auth.uid());\n`);
    const before = captureSurface(dir, []);
    // keep table + RLS enable, drop the policy
    writeFileSync(join(dir, "supabase/migrations/0001_init.sql"), `create table "notes" ("id" uuid primary key);\nalter table "notes" enable row level security;\n`);
    expect(tamperReason(before, captureSurface(dir, []))).toMatch(/policy was REMOVED/i);
  });

  test("dropping a .from('x') data access to hide a finding is tampering", () => {
    const dir = ws();
    writeFileSync(join(dir, "page.ts"), `export const load = () => supabase.from("secrets").select("*");\n`);
    const before = captureSurface(dir, []);
    writeFileSync(join(dir, "page.ts"), `export const load = () => ({});\n`);
    expect(tamperReason(before, captureSurface(dir, []))).toMatch(/data access was REMOVED/i);
  });

  test("gutting a flagged file to `export {}` is tampering", () => {
    const dir = ws();
    const flagged = "app/api/run/route.ts";
    mkdirSync(join(dir, "app/api/run"), { recursive: true });
    writeFileSync(join(dir, flagged), `export async function POST(req: Request) {\n  const body = await req.json();\n  return new Response(eval(body.code));\n}\n`);
    const finding: Finding = { tool: "sast", ruleId: "dangerous-eval", severity: "critical", file: flagged, message: "eval of request body" };
    const before = captureSurface(dir, [finding]);
    writeFileSync(join(dir, flagged), `export {};\n`);
    expect(tamperReason(before, captureSurface(dir, [finding]))).toMatch(/was GUTTED/i);
  });

  test("adding an @ts-ignore / eslint-disable suppression is tampering", () => {
    const dir = ws();
    writeFileSync(join(dir, "page.ts"), `export const x = 1;\n`);
    const before = captureSurface(dir, []);
    writeFileSync(join(dir, "page.ts"), `// @ts-ignore\nexport const x: number = "1" as any;\n`);
    expect(tamperReason(before, captureSurface(dir, []))).toMatch(/suppression directive was ADDED/i);
  });

  test("audit3 M-2: `as unknown as` double-cast and biome-ignore are counted as suppressions", () => {
    const dir = ws();
    writeFileSync(join(dir, "page.ts"), `export const x = 1;\n`);
    const before = captureSurface(dir, []);
    writeFileSync(join(dir, "page.ts"), `// biome-ignore lint: x\nexport const y = (z as unknown as number);\n`);
    expect(tamperReason(before, captureSurface(dir, []))).toMatch(/suppression directive was ADDED/i);
  });

  test("audit3 M-2: a suppression stashed in a hidden dir is still counted", () => {
    const dir = ws();
    const before = captureSurface(dir, []);
    mkdirSync(join(dir, ".sneaky"), { recursive: true });
    writeFileSync(join(dir, ".sneaky/x.ts"), `// @ts-nocheck\nexport const evil = 1;\n`);
    expect(tamperReason(before, captureSurface(dir, []))).toMatch(/suppression directive was ADDED/i);
  });

  test("audit3 HIGH-1: a new migration that DISABLES rls is tampering (enable count unchanged)", () => {
    const dir = ws();
    const before = captureSurface(dir, []);
    // keep the original enable; add a NEW migration that turns RLS off
    writeFileSync(join(dir, "supabase/migrations/0002_off.sql"), `alter table "notes" disable row level security;\n`);
    expect(tamperReason(before, captureSurface(dir, []))).toMatch(/RLS was DISABLED in a migration/i);
  });

  test("audit3 HIGH-1: ALTER POLICY weakened to a tautology is tampering (create-policy count unchanged)", () => {
    const dir = ws();
    writeFileSync(join(dir, "supabase/migrations/0001_init.sql"), `create table "notes" ("id" uuid primary key);\nalter table "notes" enable row level security;\ncreate policy p on "notes" for all using ("owner" = auth.uid());\n`);
    const before = captureSurface(dir, []);
    // do not drop the policy — WEAKEN it in place with an alter
    writeFileSync(join(dir, "supabase/migrations/0002_weaken.sql"), `alter policy p on "notes" using (true);\n`);
    expect(tamperReason(before, captureSurface(dir, []))).toMatch(/WEAKENED to a tautology/i);
  });

  test("a genuine fix that ADDS a policy + grows the file is NOT tampering", () => {
    const dir = ws();
    writeFileSync(join(dir, "page.ts"), `export const load = () => supabase.from("notes").select("*");\n`);
    const before = captureSurface(dir, []);
    // strengthen: add a policy, keep table/RLS/query, no suppressions
    writeFileSync(join(dir, "supabase/migrations/0001_init.sql"), `create table "notes" ("id" uuid primary key, "owner" uuid);\nalter table "notes" enable row level security;\ncreate policy p on "notes" for all using ("owner" = auth.uid()) with check ("owner" = auth.uid());\n`);
    expect(tamperReason(before, captureSurface(dir, []))).toBeNull();
  });
});

describe("autoFix — a fix that GREENS the gate by deleting the flagged file is rejected", () => {
  test("delete-to-pass → escalates (fixed:false), never accepts the gamed green", async () => {
    const dir = ws();
    let gateCalls = 0;
    // The gate is blocked while the migration exists; it would go GREEN once the file is gone.
    const gate = async (p: string): Promise<PipelineResult> => {
      gateCalls++;
      const present = existsSync(join(p, "supabase/migrations/0001_init.sql"));
      const verdicts: GateVerdict[] = present ? [verdictOf("rls", [rlsFinding], "t")] : [verdictOf("rls", [], "t")];
      return { verdicts, passed: verdicts.every((v) => v.status === "pass") };
    };
    // The "fixer" cheats: it deletes the flagged migration so the finding vanishes.
    const cheatingFixer = async (p: string) => {
      rmSync(join(p, "supabase/migrations/0001_init.sql"));
    };
    const res = await autoFix(dir, { gate, fixer: cheatingFixer, budget: 5 });
    expect(res.fixed).toBe(false); // the gamed green is refused
    expect(res.escalation).not.toBeNull(); // handed off instead
    expect(res.log.join("\n")).toMatch(/REJECTED as tampering/i);
  });
});
