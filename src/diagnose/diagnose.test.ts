import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectUndeclaredImports, depStatus, diagnose, formatDiagnosis, readVibehardState } from "./diagnose.ts";

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function project(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "vibehard-diag-test-"));
  tmps.push(d);
  for (const [p, c] of Object.entries(files)) await Bun.write(join(d, p), c);
  return d;
}

describe("detectUndeclaredImports", () => {
  test("flags a bare package import not in package.json", async () => {
    const d = await project({
      "package.json": JSON.stringify({ dependencies: { next: "15" } }),
      "lib/pay.ts": "import Stripe from 'stripe'; export const s = Stripe;",
    });
    expect(detectUndeclaredImports(d)).toContain("stripe");
  });

  test("ignores declared packages, relative imports, and node builtins", async () => {
    const d = await project({
      "package.json": JSON.stringify({ dependencies: { stripe: "^1" } }),
      "lib/a.ts": "import Stripe from 'stripe'; import './local'; import { readFileSync } from 'node:fs';",
    });
    expect(detectUndeclaredImports(d)).toEqual([]);
  });
});

describe("depStatus", () => {
  test("reports declared count, lockfile presence, and lockfile drift", async () => {
    const d = await project({
      "package.json": JSON.stringify({ dependencies: { svix: "^1", next: "15" } }),
      "package-lock.json": JSON.stringify({ packages: { "node_modules/next": {} } }), // svix missing from lock
    });
    const s = depStatus(d);
    expect(s.declared).toBe(2);
    expect(s.lockfilePresent).toBe(true);
    expect(s.missingFromLock).toContain("svix");
  });
});

describe("readVibehardState", () => {
  test("lists produced artifacts and a held ticket", async () => {
    const d = await project({
      ".vibehard/spec.json": "{}",
      ".vibehard/prd.json": "{}",
      ".vibehard/esc-abc123.json": "{}",
    });
    const s = readVibehardState(d);
    expect(s.artifacts).toEqual(["spec", "prd"]);
    expect(s.heldTicket).toBe("esc-abc123");
  });
});

describe("diagnose + formatDiagnosis", () => {
  test("static run names the dependency issue in the verdict", async () => {
    const d = await project({
      "package.json": JSON.stringify({ dependencies: { next: "15" } }),
      "lib/pay.ts": "import Stripe from 'stripe';",
    });
    const report = formatDiagnosis(diagnose(d));
    expect(report).toContain("UNDECLARED");
    expect(report).toContain("stripe");
    expect(report).toContain("Dependency issue");
  });

  test("non-node directory degrades gracefully", async () => {
    const d = await project({ "readme.txt": "hi" });
    expect(formatDiagnosis(diagnose(d))).toContain("not a node app");
  });
});
