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
