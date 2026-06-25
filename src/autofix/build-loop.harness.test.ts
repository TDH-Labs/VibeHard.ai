/**
 * The build/autofix regression harness. Each case below reproduces a failure class
 * that ACTUALLY held a real build this development cycle — so the gate + auto-fixer's
 * handling is locked here and runs in milliseconds, instead of being rediscovered the
 * slow way (a 30-minute live build). Fixtures: `fixtures/broken-apps/*`, captured real
 * logs: `fixtures/build-logs/*`.
 *
 * If any of these fail, the autofix loop has regressed on a known-bad input.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBuildErrors } from "../gate/build-errors.ts";
import { parseMissingModules, applyMissingDeps } from "./missingdeps.ts";
import { readFixSources } from "./fixer.ts";
import { detectUndeclaredImports } from "../diagnose/diagnose.ts";
import type { Finding } from "../types.ts";

const ROOT = join(import.meta.dir, "..", "..");
const APPS = join(ROOT, "fixtures", "broken-apps");
const LOGS = join(ROOT, "fixtures", "build-logs");
const log = (name: string): string => readFileSync(join(LOGS, name), "utf8");

const integration = process.env.VIBEHARD_INTEGRATION ? describe : describe.skip;

describe("CLASS: undeclared dependency (e.g. 'stripe')", () => {
  const dir = join(APPS, "undeclared-dep");

  test("static detector flags the imported-but-undeclared package", () => {
    expect(detectUndeclaredImports(dir)).toContain("stripe");
  });

  test("the build log parses to a deterministic 'Can't resolve' the installer recognizes", () => {
    expect(parseMissingModules(parseBuildErrors(log("undeclared-dep.log"), dir))).toEqual(["stripe"]);
  });
});

describe("CLASS: missing export (importers expect a symbol the module lacks)", () => {
  const dir = join(APPS, "missing-export");

  test("the build log localizes to the MODULE file, not package.json", () => {
    const findings = parseBuildErrors(log("missing-export.log"), dir);
    const f = findings.find((x) => x.file.endsWith("admin.ts"));
    expect(f).toBeDefined();
    expect(f!.file).toBe("lib/supabase/admin.ts");
    expect(f!.message).toContain("supabaseAdmin");
  });

  test("fixer context pulls in the module AND its importer together (so it can reconcile)", () => {
    const finding: Finding = parseBuildErrors(log("missing-export.log"), dir).find((x) => x.file.endsWith("admin.ts"))!;
    const sources = readFixSources(dir, [finding], 120_000).map((s) => s.rel);
    expect(sources).toContain("lib/supabase/admin.ts"); // the export site (named by the finding)
    expect(sources).toContain("app/actions/billing.ts"); // the importer (mentions the broken symbol)
  });
});

describe("CLASS: Next 15 async headers()/cookies() (general type error)", () => {
  test("the build log localizes to the real file:line when that file exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vibehard-harness-"));
    try {
      // the captured log blames app/api/webhooks/clerk/route.ts:15 — create it so resolution succeeds
      mkdirSync(join(tmp, "app/api/webhooks/clerk"), { recursive: true });
      writeFileSync(join(tmp, "app/api/webhooks/clerk/route.ts"), "export {}\n");
      const findings = parseBuildErrors(log("async-headers.log"), tmp);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.file).toBe("app/api/webhooks/clerk/route.ts");
      expect(findings[0]!.line).toBe(15);
      expect(findings[0]!.message).toContain("Type error");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("CLASS: server-action type mismatch (data-returning fn on a form action)", () => {
  test("the build log localizes to the component file:line", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vibehard-harness-"));
    try {
      mkdirSync(join(tmp, "components/admin"), { recursive: true });
      writeFileSync(join(tmp, "components/admin/UserListActions.tsx"), "export {}\n");
      const findings = parseBuildErrors(log("action-type-mismatch.log"), tmp);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.file).toBe("components/admin/UserListActions.tsx");
      expect(findings[0]!.line).toBe(16);
      expect(findings[0]!.message).toContain("not assignable");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("CLASS: Stripe apiVersion mismatch (post-cutoff SDK knowledge)", () => {
  test("localizes to lib/stripe.ts:line with the type error", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vibehard-harness-"));
    try {
      mkdirSync(join(tmp, "lib"), { recursive: true });
      writeFileSync(join(tmp, "lib/stripe.ts"), "export {}\n");
      const findings = parseBuildErrors(log("stripe-apiversion.log"), tmp);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.file).toBe("lib/stripe.ts");
      expect(findings[0]!.line).toBe(4);
      expect(findings[0]!.message).toContain("not assignable");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("CLASS: internal helper arity mismatch (define-vs-call disagreement)", () => {
  test("localizes to the call site with the arity error", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vibehard-harness-"));
    try {
      mkdirSync(join(tmp, "app/api/stripe/webhook"), { recursive: true });
      writeFileSync(join(tmp, "app/api/stripe/webhook/route.ts"), "export {}\n");
      const findings = parseBuildErrors(log("internal-arity.log"), tmp);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.file).toBe("app/api/stripe/webhook/route.ts");
      expect(findings[0]!.line).toBe(145);
      expect(findings[0]!.message).toContain("Expected 1 arguments");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Heavy: actually installs from the registry. Run with VIBEHARD_INTEGRATION=1.
integration("CLASS: undeclared dependency — deterministic install (live)", () => {
  test(
    "applyMissingDeps adds 'stripe' to a copy of the fixture",
    () => {
      const tmp = mkdtempSync(join(tmpdir(), "vibehard-harness-"));
      try {
        cpSync(join(APPS, "undeclared-dep"), tmp, { recursive: true });
        const res = applyMissingDeps(tmp, ["stripe"]);
        expect(res.installed).toContain("stripe");
        const pkg = JSON.parse(readFileSync(join(tmp, "package.json"), "utf8"));
        expect(pkg.dependencies.stripe).toBeDefined();
        expect(existsSync(join(tmp, "package-lock.json"))).toBe(true); // lockfile written in sync
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    120_000, // a real registry install — well past bun's 5s default
  );
});
