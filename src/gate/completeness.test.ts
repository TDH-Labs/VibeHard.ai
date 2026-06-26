import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompleteness } from "./completeness.ts";
import type { FunctionalReviewer } from "../functest/functest.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function ws(features?: string[]): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-compl-"));
  tmps.push(d);
  if (features) {
    mkdirSync(join(d, ".vibehard"), { recursive: true });
    writeFileSync(join(d, ".vibehard", "spec.json"), JSON.stringify({ name: "app", features }));
  }
  return d;
}

describe("completeness gate", () => {
  test("blocks on a MISSING feature, with an actionable build order", async () => {
    const reviewer: FunctionalReviewer = async () => [
      { feature: "child enrollment", status: "works", note: "full CRUD" },
      { feature: "attendance check-in/out", status: "missing", note: "no page exists" },
    ];
    const v = await runCompleteness(ws(["child enrollment", "attendance check-in/out"]), { reviewer });
    expect(v.status).toBe("block");
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.ruleId).toBe("feature-missing");
    expect(v.findings[0]!.message).toContain("attendance check-in/out");
    expect(v.findings[0]!.message).toMatch(/BUILD it/);
  });

  test("a 'partial' feature is NOT blocked (too subjective to gate on)", async () => {
    const reviewer: FunctionalReviewer = async () => [{ feature: "billing", status: "partial", note: "list only" }];
    const v = await runCompleteness(ws(["billing"]), { reviewer });
    expect(v.status).toBe("pass");
  });

  test("all features present → pass", async () => {
    const reviewer: FunctionalReviewer = async () => [{ feature: "x", status: "works", note: "" }];
    expect((await runCompleteness(ws(["x"]), { reviewer })).status).toBe("pass");
  });

  test("no spec (didn't go through planning) → N/A, no block", async () => {
    expect((await runCompleteness(ws(undefined), { reviewer: async () => [] })).status).toBe("n/a");
  });

  test("reviewer with no app code to read → N/A, no block (empty result, not a failure)", async () => {
    const v = await runCompleteness(ws(["x"]), { reviewer: async () => [] });
    expect(v.status).toBe("n/a");
  });

  test("does NOT block a 'missing' verdict when the feature IS implemented on disk (false-negative guard)", async () => {
    const d = ws(["immunization and health records"]);
    mkdirSync(join(d, "app", "(dashboard)", "children", "[id]", "health-records"), { recursive: true });
    writeFileSync(join(d, "app", "(dashboard)", "children", "[id]", "health-records", "page.tsx"), "export default function P(){return null}");
    const reviewer: FunctionalReviewer = async () => [{ feature: "immunization and health records", status: "missing", note: "no top-level route" }];
    const v = await runCompleteness(d, { reviewer });
    expect(v.status).toBe("pass"); // a route named for the feature exists → not actually missing
  });

  test("STILL blocks a 'missing' verdict when nothing on disk matches the feature (real gap)", async () => {
    const d = ws(["payroll exports"]);
    mkdirSync(join(d, "app"), { recursive: true });
    writeFileSync(join(d, "app", "page.tsx"), "export default function P(){return null}");
    const reviewer: FunctionalReviewer = async () => [{ feature: "payroll exports", status: "missing", note: "absent" }];
    const v = await runCompleteness(d, { reviewer });
    expect(v.status).toBe("block"); // no payroll/exports file anywhere → genuinely missing
  });

  test("FAILS CLOSED when the reviewer can't produce a verdict (no false pass on infra failure)", async () => {
    const reviewer: FunctionalReviewer = async () => {
      throw new Error("functional reviewer produced no usable checks (model=deepseek-v4-flash)");
    };
    const v = await runCompleteness(ws(["billing", "attendance"]), { reviewer });
    expect(v.status).toBe("block"); // couldn't verify ⇒ must NOT pass
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.ruleId).toBe("completeness-unverified"); // distinct from feature-missing
    expect(v.findings[0]!.message).toMatch(/NOT a code change|infra/i); // tells the fixer it's not a feature to build
  });
});
