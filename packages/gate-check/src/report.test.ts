import { afterEach, describe, expect, test } from "bun:test";
import { printReport, type ReportResult } from "./report.ts";

const ts = "2026-07-23T00:00:00.000Z";

describe("printReport — the scope caveat (2026-07-23)", () => {
  let spy: string[] = [];
  const original = console.log;
  afterEach(() => {
    console.log = original;
    spy = [];
  });

  function capture(): void {
    spy = [];
    console.log = (...args: unknown[]) => {
      spy.push(args.map(String).join(" "));
    };
  }

  test("a PASS result still prints the scope caveat — a clean run must not read as a business-logic security review", () => {
    capture();
    const result: ReportResult = { verdicts: [{ gate: "sast", status: "pass", findings: [], blocking: 0, ranAt: ts }], passed: true };
    printReport(result);
    const out = spy.join("\n");
    expect(out).toContain("do NOT reason about your application's");
    expect(out).toContain("PASS — deploy allowed");
  });

  test("a BLOCK result also prints the scope caveat, before the final verdict line", () => {
    capture();
    const result: ReportResult = {
      verdicts: [{ gate: "secrets", status: "block", findings: [{ tool: "gitleaks", ruleId: "generic-secret", severity: "critical", file: "x.ts", message: "found a key" }], blocking: 1, ranAt: ts }],
      passed: false,
    };
    printReport(result);
    const scopeIdx = spy.findIndex((l) => l.includes("do NOT reason about"));
    const verdictIdx = spy.findIndex((l) => l.includes("BLOCK — deploy refused"));
    expect(scopeIdx).toBeGreaterThanOrEqual(0);
    expect(verdictIdx).toBeGreaterThan(scopeIdx);
  });
});
