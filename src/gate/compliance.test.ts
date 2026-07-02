import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessCompliance, detectDeletePath, runCompliance, type ComplianceInput } from "./compliance.ts";
import { isBlocking, verdictOf } from "../types.ts";

function input(over: Partial<ComplianceInput> = {}): ComplianceInput {
  return {
    sensitiveClasses: ["pii", "financial"],
    authenticated: true,
    storesData: true,
    hasDeletePath: true,
    suspiciousLogging: [],
    ...over,
  };
}
const ruleIds = (i: ComplianceInput) => assessCompliance(i).map((f) => f.ruleId);

describe("detectDeletePath — F4 (audit2): the literal 'DELETE' string can't fake a delete path", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = (files: Record<string, string>): string => {
    const d = mkdtempSync(join(tmpdir(), "dd-compl-"));
    dirs.push(d);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(d, name, ".."), { recursive: true });
      writeFileSync(join(d, name), content);
    }
    return d;
  };

  test("an HTTP-method string `method:\"DELETE\"` does NOT count as a hard-delete path", () => {
    expect(detectDeletePath(dir({ "client.ts": `await fetch("/api/x", { method: "DELETE" });` }))).toBe(false);
  });

  test("a real `.delete()` / `delete from` / Next DELETE handler DOES count", () => {
    expect(detectDeletePath(dir({ "a.ts": `await supabase.from("notes").delete().eq("id", id);` }))).toBe(true);
    expect(detectDeletePath(dir({ "m.sql": `DELETE FROM notes WHERE id = $1;` }))).toBe(true);
    expect(detectDeletePath(dir({ "route.ts": `export async function DELETE(req: Request) { /* ... */ }` }))).toBe(true);
  });
});

describe("assessCompliance — §21 seven controls (verifiable BLOCK, judgment advisory)", () => {
  test("a non-sensitive app → no assessment at all (the gate is classification-driven)", () => {
    expect(assessCompliance(input({ sensitiveClasses: [] }))).toEqual([]);
  });

  test("a sound sensitive app → no BLOCKING findings, but governance + applicability advisories", () => {
    const fs = assessCompliance(input());
    expect(fs.filter(isBlocking)).toEqual([]); // auth + delete path present
    const ids = fs.map((f) => f.ruleId);
    expect(ids).toContain("governance-posture"); // org-level, surfaced
    expect(ids).toContain("compliance-applicability");
    expect(verdictOf("compliance", fs, "2026-06-21T00:00:00.000Z").status).toBe("pass"); // advisories don't block
  });

  test("Control 3 — sensitive data with no auth → CRITICAL block", () => {
    const f = assessCompliance(input({ authenticated: false })).find((x) => x.ruleId === "unauthenticated-sensitive-data");
    expect(f?.severity).toBe("critical");
    expect(verdictOf("compliance", assessCompliance(input({ authenticated: false })), "t").status).toBe("block");
  });

  test("Control 2 — sensitive data stored with no hard-delete path → blocks", () => {
    expect(ruleIds(input({ hasDeletePath: false }))).toContain("no-deletion-path");
    // ...but only when it actually stores data
    expect(ruleIds(input({ hasDeletePath: false, storesData: false }))).not.toContain("no-deletion-path");
  });

  test("Control 5 — a suspicious log site → a MEDIUM advisory per site (not a block)", () => {
    const fs = assessCompliance(input({ suspiciousLogging: ["server.ts:42"] }));
    const log = fs.find((x) => x.ruleId === "pii-logging-review");
    expect(log?.severity).toBe("medium");
    expect(log?.message).toContain("server.ts:42");
  });

  test("Control 7 — applicability scales with the data classes (PHI → Privacy, financial → Processing Integrity)", () => {
    const phi = assessCompliance(input({ sensitiveClasses: ["phi"] })).find((f) => f.ruleId === "compliance-applicability")!;
    expect(phi.message).toMatch(/Privacy/);
    const fin = assessCompliance(input({ sensitiveClasses: ["financial"] })).find((f) => f.ruleId === "compliance-applicability")!;
    expect(fin.message).toMatch(/Processing Integrity/);
  });
});

describe("runCompliance — D-1 (SECURITY_AUDIT_4): the classification is falsifiable", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const app = (files: Record<string, string>, spec?: object): string => {
    const d = mkdtempSync(join(tmpdir(), "dd-d1-"));
    dirs.push(d);
    if (spec !== undefined) {
      mkdirSync(join(d, ".vibehard"), { recursive: true });
      writeFileSync(join(d, ".vibehard", "spec.json"), JSON.stringify(spec));
    }
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(d, name, ".."), { recursive: true });
      writeFileSync(join(d, name), content);
    }
    return d;
  };

  test("spec says 'none' but the schema stores SSNs → gate RUNS and BLOCKS with classification-mismatch", async () => {
    const d = app(
      { "supabase/migrations/001.sql": "create table clients (id uuid, ssn text);" },
      { name: "x", sensitiveData: ["none"], dataEntities: [], auth: "none" },
    );
    const v = await runCompliance(d, "t");
    expect(v.status).toBe("block");
    const ids = v.findings.map((f) => f.ruleId);
    expect(ids).toContain("classification-mismatch");
    expect(ids).toContain("unauthenticated-sensitive-data"); // full assessment ran on the inferred class
  });

  test("NO spec at all + sensitive code → same rescue (the no-front-half hole is closed)", async () => {
    const d = app({ "src/records.ts": "interface Visit { diagnosis: string }" });
    const v = await runCompliance(d, "t");
    expect(v.status).toBe("block");
    expect(v.findings.map((f) => f.ruleId)).toContain("classification-mismatch");
  });

  test("spec says 'none' and the code corroborates it → fast N/A preserved (no false blocks)", async () => {
    const d = app(
      { "supabase/migrations/001.sql": "create table todos (id uuid, title text);", "src/app.ts": "export const x = 1;" },
      { name: "x", sensitiveData: ["none"], dataEntities: [] },
    );
    const v = await runCompliance(d, "t");
    expect(v.status).toBe("n/a");
    expect(v.blocking).toBe(0);
  });

  test("an HONEST declaration is unaffected: declared pii still assesses exactly as before", async () => {
    const d = app(
      { "supabase/migrations/001.sql": "create table clients (id uuid, ssn text);", "src/api.ts": "await db.from('clients').delete().eq('id', id);" },
      { name: "x", sensitiveData: ["pii"], auth: "password", storesData: true },
    );
    const v = await runCompliance(d, "t");
    expect(v.findings.map((f) => f.ruleId)).not.toContain("classification-mismatch");
    expect(v.status).toBe("pass"); // auth + delete path present → advisories only
  });
});

describe("§16 BINDING — the assessment never CLAIMS compliance", () => {
  test("no finding message uses a claim word, even while naming frameworks", () => {
    const variants = [input(), input({ authenticated: false, hasDeletePath: false }), input({ sensitiveClasses: ["phi", "financial", "credentials"] })];
    for (const i of variants) {
      for (const f of assessCompliance(i)) {
        expect(f.message.toLowerCase()).not.toMatch(/\b(compliant|certified|certification)\b/);
        expect(f.message.toLowerCase()).not.toMatch(/\b(hipaa|soc ?2)[- ]?(compliant|certified|ready)\b/);
      }
    }
  });
});
