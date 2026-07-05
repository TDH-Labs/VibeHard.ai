import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePropertyTests, MAX_PROPTEST_REQUIREMENTS } from "./generate.ts";
import { PROPTEST_DIR } from "./validate.ts";
import type { Requirement } from "../prd/index.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function app(): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-ptgen-"));
  tmps.push(d);
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x", devDependencies: {} }));
  mkdirSync(join(d, "lib"), { recursive: true });
  writeFileSync(join(d, "lib", "clamp.ts"), "export const clamp=(x:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,x));");
  mkdirSync(join(d, "node_modules", "fast-check"), { recursive: true }); // pretend installed
  return d;
}
const req = (id: string, priority: Requirement["priority"] = "MVP"): Requirement => ({
  id,
  feature: "clamping",
  detail: "values are clamped",
  acceptance: ["output is always within [lo, hi]"],
  priority,
  scenarioRefs: [],
});

const VALID = `// @requirement F1
import { test } from "bun:test";
import fc from "fast-check";
import { clamp } from "../../lib/clamp";
test("F1", () => { fc.assert(fc.property(fc.integer(), (x) => clamp(x, 0, 5) >= 0), { seed: 42 }); });
`;

const okRun = () => ({ exitCode: 0, output: "1 pass" });
const okInstall = () => 0;

describe("generatePropertyTests", () => {
  test("a valid, passing test is written and reported", async () => {
    const dir = app();
    const r = await generatePropertyTests(dir, [req("F1")], { generate: async () => VALID, runTest: okRun, install: okInstall });
    expect(r.written).toEqual([join(PROPTEST_DIR, "f1.test.ts")]);
    expect(readFileSync(join(dir, PROPTEST_DIR, "f1.test.ts"), "utf8")).toContain("@requirement F1");
    // the devDependency landed
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).devDependencies["fast-check"]).toBeDefined();
  });

  test("a vacuous first attempt gets ONE retry with the reason; still bad → skipped, nothing written", async () => {
    const dir = app();
    const prompts: string[] = [];
    const r = await generatePropertyTests(dir, [req("F1")], {
      generate: async (_s, p) => (prompts.push(p), "// @requirement F1\nno real test"),
      runTest: okRun,
      install: okInstall,
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("rejected");
    expect(r.written).toEqual([]);
    expect(r.skipped[0]!.reason).toContain("invalid test");
    expect(existsSync(join(dir, PROPTEST_DIR, "f1.test.ts"))).toBe(false);
  });

  test("a test that FAILS against the app at generation time is never left on disk (no red ratchet)", async () => {
    const dir = app();
    const r = await generatePropertyTests(dir, [req("F1")], {
      generate: async () => VALID,
      runTest: () => ({ exitCode: 1, output: "(fail) F1\nCounterexample: [-1]" }),
      install: okInstall,
    });
    expect(r.written).toEqual([]);
    expect(r.skipped[0]!.reason).toContain("did not pass");
    expect(existsSync(join(dir, PROPTEST_DIR, "f1.test.ts"))).toBe(false);
  });

  test("model SKIP → honest skip, not fake coverage", async () => {
    const r = await generatePropertyTests(app(), [req("F1")], { generate: async () => "SKIP", runTest: okRun, install: okInstall });
    expect(r.written).toEqual([]);
    expect(r.skipped[0]!.reason).toContain("purely testable");
  });

  test("MVP requirements are picked first and the count is capped", async () => {
    const reqs = [...Array.from({ length: 4 }, (_, i) => req(`P${i}`, "P1")), ...Array.from({ length: 5 }, (_, i) => req(`M${i}`, "MVP"))];
    const asked: string[] = [];
    await generatePropertyTests(app(), reqs, {
      generate: async (_s, p) => (asked.push(p.split("\n")[0]!), "SKIP"),
      runTest: okRun,
      install: okInstall,
    });
    expect(asked).toHaveLength(MAX_PROPTEST_REQUIREMENTS);
    expect(asked.slice(0, 5).every((a) => a.includes("Requirement M"))).toBe(true);
  });

  test("model failure → skipped with the error, generation never throws", async () => {
    const r = await generatePropertyTests(app(), [req("F1")], {
      generate: async () => {
        throw new Error("model down");
      },
      runTest: okRun,
      install: okInstall,
    });
    expect(r.skipped[0]!.reason).toContain("model down");
  });
});
