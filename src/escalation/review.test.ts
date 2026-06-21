import { describe, expect, test } from "bun:test";
import { applyWaivers, waiversFromDecisions, type ReviewDecision, type Waiver } from "./review.ts";
import { findingRef } from "./packet.ts";
import type { Finding, GateVerdict } from "../types.ts";

const ts = "2026-06-21T00:00:00.000Z";
const finding = (over: Partial<Finding> = {}): Finding => ({
  tool: "semgrep",
  ruleId: "sqli",
  severity: "high",
  file: "/src/server.js",
  line: 30,
  message: "SQL injection",
  ...over,
});
const verdict = (gate: string, findings: Finding[]): GateVerdict => ({
  gate,
  status: findings.some((f) => f.severity === "high" || f.severity === "critical" || f.tool === "gitleaks") ? "block" : "pass",
  findings,
  blocking: findings.length,
  ranAt: ts,
});

describe("waiversFromDecisions (never silent skip)", () => {
  const decisions: ReviewDecision[] = [
    { ref: "a:1:r", verdict: "approved", reviewer: "eng", justification: "example key, not live", decidedAt: ts },
    { ref: "b:2:r", verdict: "approved", reviewer: "eng", justification: "  ", decidedAt: ts }, // blank → invalid
    { ref: "c:3:r", verdict: "rejected", reviewer: "eng", decidedAt: ts },
    { ref: "d:4:r", verdict: "fixed", reviewer: "eng", decidedAt: ts },
  ];
  test("only a justified approval becomes a waiver", () => {
    const { waivers, invalid } = waiversFromDecisions(decisions);
    expect(waivers.map((w) => w.ref)).toEqual(["a:1:r"]);
    expect(waivers[0]!.justification).toBe("example key, not live");
  });
  test("an approval with no justification is surfaced as invalid, not honored", () => {
    const { invalid } = waiversFromDecisions(decisions);
    expect(invalid.map((d) => d.ref)).toEqual(["b:2:r"]);
  });
});

describe("applyWaivers (downgrade with justification, recorded)", () => {
  test("waiving the only blocking finding flips block → pass and records it", () => {
    const f = finding();
    const verdicts = [verdict("sast", [f])];
    const waiver: Waiver = { ref: findingRef(f), reviewer: "eng", justification: "false positive", waivedAt: ts };

    const r = applyWaivers(verdicts, [waiver]);
    expect(r.passed).toBe(true);
    expect(r.verdicts[0]!.status).toBe("pass");
    expect(r.verdicts[0]!.blocking).toBe(0);
    expect(r.verdicts[0]!.findings).toHaveLength(1); // downgrade, not delete — still on record
    expect(r.waived.map(findingRef)).toEqual([findingRef(f)]);
  });

  test("a partial waiver still blocks on the remaining finding", () => {
    const a = finding({ ruleId: "sqli", line: 30 });
    const b = finding({ ruleId: "stripe", tool: "gitleaks", line: 10 });
    const r = applyWaivers([verdict("sast", [a, b])], [
      { ref: findingRef(a), reviewer: "eng", justification: "fp", waivedAt: ts },
    ]);
    expect(r.passed).toBe(false);
    expect(r.verdicts[0]!.blocking).toBe(1);
    expect(r.waived).toHaveLength(1);
  });

  test("a waiver pointed at a non-blocking finding is a no-op", () => {
    const low = finding({ severity: "low", ruleId: "style" });
    const r = applyWaivers([verdict("sast", [low])], [
      { ref: findingRef(low), reviewer: "eng", justification: "x", waivedAt: ts },
    ]);
    expect(r.waived).toHaveLength(0);
    expect(r.passed).toBe(true); // it never blocked
  });
});
