import { describe, expect, test } from "bun:test";
import { parseDepFinding, pickBumpTarget } from "./depbump.ts";
import type { Finding } from "../types.ts";

const dep = (message: string): Finding => ({ tool: "trivy", ruleId: "CVE-x", severity: "high", file: "package-lock.json", message });

describe("parseDepFinding", () => {
  test("parses pkg, installed, and the fixed-version list (real trivy message shape)", () => {
    const p = parseDepFinding(dep("next@14.2.5: nextjs: Authorization Bypass in Next.js Middleware (fixed in 13.5.9, 14.2.25, 15.2.3, 12.3.5)"));
    expect(p).toEqual({ pkg: "next", installed: "14.2.5", fixed: ["13.5.9", "14.2.25", "15.2.3", "12.3.5"] });
  });

  test("returns null for 'no fix available' or an unparseable message", () => {
    expect(parseDepFinding(dep("foo@1.0.0: something (no fix available yet)"))).toBeNull();
    expect(parseDepFinding(dep("garbage"))).toBeNull();
  });
});

describe("pickBumpTarget (safe in-major bump)", () => {
  test("picks the highest SAME-MAJOR fix greater than installed", () => {
    expect(pickBumpTarget("14.2.5", ["13.5.9", "14.2.25", "15.2.3", "12.3.5"])).toBe("14.2.25");
    expect(pickBumpTarget("14.2.5", ["14.2.25", "14.2.35", "15.0.7"])).toBe("14.2.35");
  });

  test("null when every fix needs a major upgrade (don't auto-break the app)", () => {
    expect(pickBumpTarget("14.2.5", ["15.2.3", "16.0.0"])).toBeNull();
  });

  test("null when the only same-major 'fix' is not newer than installed", () => {
    expect(pickBumpTarget("14.2.25", ["14.2.10", "13.0.0"])).toBeNull();
  });
});
