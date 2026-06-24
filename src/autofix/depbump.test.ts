import { describe, expect, test } from "bun:test";
import { parseDepFinding, pickBumpTarget, pickMajorTarget, planDepBumps } from "./depbump.ts";
import type { Finding } from "../types.ts";

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; overrides?: Record<string, string> };

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

describe("pickMajorTarget (breaking fallback)", () => {
  test("highest STABLE version in the LOWEST major above installed (minimal jump)", () => {
    // the real Next-14 case: fixes scattered across 15.x and 16.x → take the top 15.x
    expect(pickMajorTarget("14.2.35", ["15.0.8", "15.5.16", "16.2.5"])).toBe("15.5.16");
    expect(pickMajorTarget("14.2.5", ["15.2.3", "16.0.0"])).toBe("15.2.3");
  });
  test("jumps only ONE major even if higher ones exist (a remaining CVE re-surfaces next round)", () => {
    expect(pickMajorTarget("14.0.0", ["16.2.5", "17.0.0"])).toBe("16.2.5"); // lowest higher major is 16 (no 15.x fix)
  });
  test("ignores pre-release / canary versions", () => {
    expect(pickMajorTarget("14.2.35", ["15.5.16", "15.6.0-canary.61"])).toBe("15.5.16");
  });
  test("null when there is no higher-major fix", () => {
    expect(pickMajorTarget("14.2.5", ["14.2.25", "13.0.0"])).toBeNull();
  });
});

describe("planDepBumps — direct bump vs transitive override (mutates the manifest in place)", () => {
  test("a DIRECT vulnerable dep is bumped in place (same-major)", () => {
    const pkg: Manifest = { dependencies: { next: "14.2.5" } };
    const plan = planDepBumps(pkg, [dep("next@14.2.5: bypass (fixed in 14.2.25, 15.2.3)")]);
    expect(pkg.dependencies?.next).toBe("14.2.25");
    expect(plan.bumped).toEqual([{ pkg: "next", from: "14.2.5", to: "14.2.25" }]);
    expect(plan.overridden).toEqual([]);
    expect(pkg.overrides).toBeUndefined();
  });

  test("a DIRECT dep with only a higher-major fix → majorBumped (breaking fallback)", () => {
    const pkg: Manifest = { dependencies: { next: "14.2.5" } };
    const plan = planDepBumps(pkg, [dep("next@14.2.5: bypass (fixed in 15.2.3)")]);
    expect(pkg.dependencies?.next).toBe("15.2.3");
    expect(plan.majorBumped).toEqual([{ pkg: "next", from: "14.2.5", to: "15.2.3" }]);
  });

  test("a TRANSITIVE dep (not on the dependency list) is forced via an npm override; direct deps untouched", () => {
    const pkg: Manifest = { dependencies: { "@clerk/nextjs": "^5.0.0" } }; // js-cookie is nested inside, not listed
    const plan = planDepBumps(pkg, [dep("js-cookie@3.0.5: XSS (fixed in 3.0.7)")]);
    expect(pkg.overrides).toEqual({ "js-cookie": "3.0.7" });
    expect(plan.overridden).toEqual([{ pkg: "js-cookie", from: "3.0.5", to: "3.0.7" }]);
    expect(plan.bumped).toEqual([]);
    expect(pkg.dependencies?.["@clerk/nextjs"]).toBe("^5.0.0");
  });

  test("the dashboard-build case: direct Clerk bumped + transitive js-cookie/postcss overridden", () => {
    const pkg: Manifest = { dependencies: { "@clerk/clerk-react": "5.12.0" }, devDependencies: { tailwindcss: "^3.4.0" } };
    const plan = planDepBumps(pkg, [
      dep("@clerk/clerk-react@5.12.0: authz bypass (fixed in 5.61.6)"),
      dep("js-cookie@3.0.5: XSS (fixed in 3.0.7)"),
      dep("postcss@8.4.31: XSS (fixed in 8.5.10)"),
    ]);
    expect(pkg.dependencies?.["@clerk/clerk-react"]).toBe("5.61.6"); // direct → bumped in place
    expect(pkg.overrides).toEqual({ "js-cookie": "3.0.7", postcss: "8.5.10" }); // transitive → overrides
    expect(plan.bumped.map((b) => b.pkg)).toEqual(["@clerk/clerk-react"]);
    expect(plan.overridden.map((o) => o.pkg).sort()).toEqual(["js-cookie", "postcss"]);
  });
});
