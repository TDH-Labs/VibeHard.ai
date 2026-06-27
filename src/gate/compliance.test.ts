import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessCompliance, detectDeletePath, type ComplianceInput } from "./compliance.ts";
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
