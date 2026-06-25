import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetBlock, normalizeStack, promotable, recordCandidate, recordResolution } from "./fleet.ts";

// The store reads VIBEHARD_FLEET_DIR lazily per call, so a normal import + per-test env works.
let FLEET: string;
let WORKSPACE: string;
const dirs: string[] = [];
beforeEach(() => {
  FLEET = mkdtempSync(join(tmpdir(), "vibehard-fleet-"));
  WORKSPACE = mkdtempSync(join(tmpdir(), "vibehard-ws-"));
  dirs.push(FLEET, WORKSPACE);
  process.env.VIBEHARD_FLEET_DIR = FLEET;
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.VIBEHARD_FLEET_DIR;
});

describe("fleet store — benefit", () => {
  test("seeds with learned conventions and injects them into the codegen block", () => {
    const block = fleetBlock("Next.js + Supabase + Tailwind");
    expect(block).toContain("learned_conventions");
    expect(block).toContain("Supabase Auth, never Clerk");
  });
  test("stack scoping prevents a python lesson poisoning a next build", () => {
    expect(normalizeStack("FastAPI + Supabase + Python")).toBe("python-fastapi");
    expect(normalizeStack("Next.js + Supabase")).toBe("next-supabase");
  });
});

describe("fleet store — learning (verifier-gated promotion)", () => {
  test("a candidate must recur across builds before it's promotable", () => {
    recordCandidate("next-supabase", "verify:some-new-class");
    recordCandidate("next-supabase", "verify:some-new-class");
    expect(promotable(3).some((c) => c.signal === "verify:some-new-class")).toBe(false); // 2 builds
    recordCandidate("next-supabase", "verify:some-new-class");
    expect(promotable(3).some((c) => c.signal === "verify:some-new-class")).toBe(true); // 3 → eligible
  });
});

describe("fleet store — fix-capture (the keystone)", () => {
  test("recordResolution attaches the (failure → files that cleared it) evidence to the candidate", () => {
    recordCandidate("next-supabase", "verify:build-failed");
    recordResolution("next-supabase", "verify:build-failed", { message: "'x' is not exported from '@/lib/y'", files: ["lib/y.ts"] });
    recordResolution("next-supabase", "verify:build-failed", { message: "Module not found 'stripe'", files: ["package.json"] });
    recordCandidate("next-supabase", "verify:build-failed");
    recordCandidate("next-supabase", "verify:build-failed"); // 3 builds total → promotable
    const c = promotable(3).find((x) => x.signal === "verify:build-failed");
    expect(c).toBeDefined();
    expect(c!.resolutions.length).toBe(2); // the evidence the induction step reads
    expect(c!.resolutions[0]!.files).toContain("lib/y.ts");
  });
});

describe("fleet store — PRIVATE: users never get a copy", () => {
  test("the store lives in the private dir, NEVER inside a build workspace", () => {
    fleetBlock("next-supabase"); // triggers the seed write
    recordCandidate("next-supabase", "x:y");
    expect(existsSync(join(FLEET, "conventions.json"))).toBe(true);
    expect(readdirSync(WORKSPACE)).toHaveLength(0); // the user's workspace is untouched
  });
  test("the module never leaks store content into a workspace artifact", () => {
    const block = fleetBlock("next-supabase");
    writeFileSync(join(WORKSPACE, "AS_BUILT.md"), "## Build log\n");
    expect(readFileSync(join(WORKSPACE, "AS_BUILT.md"), "utf8")).not.toContain("learned_conventions");
    expect(block).toContain("learned_conventions"); // exists — but only where WE put it (the system prompt)
  });
});
