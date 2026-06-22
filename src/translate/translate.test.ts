import { describe, expect, test } from "bun:test";
import { translateFinding, translateFindings, type Explanation } from "./translate.ts";
import type { Finding } from "../types.ts";

const f = (over: Partial<Finding>): Finding => ({
  tool: "semgrep",
  ruleId: "x",
  severity: "high",
  file: "a",
  message: "m",
  ...over,
});

describe("translateFinding — every ruleId our gates emit is covered (no generic)", () => {
  // The full set of ruleIds the shipped gates produce. None should fall to generic.
  const OURS: Array<[string, string]> = [
    ["rls", "rls-disabled"],
    ["rls", "rls-policy-using-true"],
    ["rls", "rls-missing"],
    ["rls", "rls-policy-authenticated"],
    ["spec", "no-features"],
    ["spec", "no-data-model"],
    ["spec", "no-auth-for-sensitive"],
    ["spec", "tenant-isolation-required"],
    ["spec", "no-retention-plan"],
    ["spec", "sensitive-classification-gap"],
    ["prd", "requirement-coverage-gap"],
    ["prd", "no-acceptance-criteria"],
    ["prd", "no-nfrs"],
    ["architecture", "no-workstreams"],
    ["architecture", "workstream-no-files"],
    ["architecture", "unknown-dependency"],
    ["architecture", "dependency-cycle"],
    ["compliance", "unauthenticated-sensitive-data"],
    ["compliance", "no-deletion-path"],
    ["compliance", "pii-logging-review"],
    ["compliance", "governance-posture"],
    ["compliance", "compliance-applicability"],
    ["prod-readiness", "unpinned-dependency"],
    ["prod-readiness", "missing-readme"],
    ["prod-readiness", "container-runs-as-root"],
    ["prod-readiness", "unpinned-base-image"],
    ["prod-readiness", "missing-dockerignore"],
    ["prod-readiness", "typescript-not-strict"],
    ["verify", "health-check-failed"],
    ["verify", "no-entry-point"],
    ["verify", "build-failed"],
    ["verify", "install-failed"],
    ["verify", "clean-verify-failed"],
    ["verify", "unclean-shutdown"],
    ["semgrep", "scan-failed"],
    ["gitleaks", "scan-failed"],
    ["semgrep", "rules.sqlite-template-literal-query"],
    ["gitleaks", "stripe-access-token"],
  ];

  for (const [tool, ruleId] of OURS) {
    test(`${tool}:${ruleId} → dictionary/heuristic, not generic`, () => {
      const e = translateFinding(f({ tool, ruleId }));
      expect(e.source).not.toBe("generic");
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.detail.length).toBeGreaterThan(0);
      expect(e.ruleId).toBe(ruleId);
    });
  }
});

describe("translateFinding — matching tiers", () => {
  test("exact: an own ruleId resolves from the dictionary, consequence-framed", () => {
    const e = translateFinding(f({ tool: "rls", ruleId: "rls-policy-using-true" }));
    expect(e.source).toBe("dictionary");
    expect(e.title).toMatch(/every user|everyone/i);
  });

  test("exact-by-substring: semgrep's long namespaced stripe id still resolves", () => {
    const e = translateFinding(
      f({ ruleId: "generic.secrets.security.detected-stripe-api-key.detected-stripe-api-key" }),
    );
    expect(e.source).toBe("dictionary");
    expect(e.title).toMatch(/payment key/i);
  });

  test("keyword: an unknown semgrep SQLi id lands in the SQL-injection family", () => {
    const e = translateFinding(f({ ruleId: "python.lang.security.audit.dangerous-sql-string" }));
    expect(e.source).toBe("heuristic");
    expect(e.title).toMatch(/SQL injection/i);
  });

  test("keyword: an unknown XSS id lands in the XSS family", () => {
    expect(translateFinding(f({ ruleId: "js.react.xss.dangerouslySetInnerHTML" })).title).toMatch(/cross-site/i);
  });

  test("tool-level: a trivy CVE (open-ended ruleId) → the dep-vuln explanation", () => {
    const e = translateFinding(f({ tool: "trivy", ruleId: "CVE-2019-10744", severity: "critical" }));
    expect(e.source).toBe("dictionary");
    expect(e.title).toMatch(/dependency .* vulnerability/i);
    expect(e.detail).toMatch(/CVE|patched version|update the package/i);
  });

  test("trivy's scan-failed still resolves exact (fail-closed), not tool-level", () => {
    expect(translateFinding(f({ tool: "trivy", ruleId: "scan-failed" })).title).toMatch(/couldn't run/i);
  });

  test("generic: a truly unknown id from a tool with no entry is still explained", () => {
    const e = translateFinding(f({ ruleId: "some.obscure.unmatched.check", severity: "medium", tool: "semgrep" }));
    expect(e.source).toBe("generic");
    expect(e.detail).toContain("semgrep");
    expect(e.detail).toContain("medium");
  });
});

describe("§16 compliance guard — no explanation CLAIMS compliance/certification", () => {
  // §16 BINDING is about CLAIMS ("HIPAA compliant", "SOC 2 certified"), not mentions —
  // the compliance gate legitimately NAMES frameworks to state applicability ("SOC 2
  // Security likely applies… it does not certify"). So the guard bans the claim words,
  // not the framework names.
  test("no entry uses a compliance-CLAIM word (compliant / certified / certification)", () => {
    const ids = [
      "rls-disabled",
      "rls-policy-using-true",
      "rls-missing",
      "rls-policy-authenticated",
      "no-auth-for-sensitive",
      "tenant-isolation-required",
      "no-retention-plan",
      "governance-posture",
      "compliance-applicability",
      "no-deletion-path",
      "scan-failed",
      "rules.sqlite-template-literal-query",
      "detected-stripe-api-key",
      "private-key",
      "x.xss.y",
      "x.ssrf.y",
    ];
    for (const ruleId of ids) {
      const e = translateFinding(f({ ruleId }));
      expect(`${e.title} ${e.detail}`.toLowerCase()).not.toMatch(/\b(compliant|certified|certification)\b/);
    }
  });
});

describe("translateFindings — LLM fallback seam", () => {
  test("the translator enriches ONLY would-be-generic findings; curated content wins", async () => {
    const findings = [
      f({ tool: "rls", ruleId: "rls-disabled" }), // dictionary — translator must NOT touch
      f({ tool: "semgrep", ruleId: "totally.unknown.rule" }), // generic — translator enriches
    ];
    const calls: string[] = [];
    const translator = (finding: Finding): Explanation => {
      calls.push(finding.ruleId);
      return { ruleId: finding.ruleId, title: "LLM title", detail: "LLM detail", source: "llm" };
    };
    const out = await translateFindings(findings, translator);

    expect(calls).toEqual(["totally.unknown.rule"]); // only the unmatched one
    expect(out[0]!.source).toBe("dictionary");
    expect(out[1]!.source).toBe("llm");
  });

  test("with no translator, everything still resolves deterministically", async () => {
    const out = await translateFindings([f({ ruleId: "unmatched" })]);
    expect(out[0]!.source).toBe("generic");
  });
});
