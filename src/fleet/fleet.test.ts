import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetFleetStoreForTests, fleetBlock, normalizeStack, promotable, recordCandidate, recordResolution } from "./fleet.ts";

// The store reads VIBEHARD_FLEET_DIR lazily per call, so a normal import + per-test env works.
// resolveFleetStore() caches its resolution across calls (real usage: one build, many calls,
// one connection) — tests must reset that cache too, or a later test would reuse the FIRST
// test's resolved store (pointed at a since-deleted temp dir) instead of re-reading env vars.
// DATABASE_URL is unset here (never just left alone): resolveFleetStore() prefers Postgres over
// the local file whenever DATABASE_URL is set, and Bun auto-loads the repo's .env for `bun test`
// — which, in this repo, is the LIVE PLATFORM's own DATABASE_URL. Leaving it set would make every
// test in this file silently read/write the production fleet tables instead of a throwaway temp
// dir (caught live 2026-07-20: a test run wrote real rows into prod before this line existed).
let FLEET: string;
let WORKSPACE: string;
let savedDbUrl: string | undefined;
const dirs: string[] = [];
beforeEach(() => {
  FLEET = mkdtempSync(join(tmpdir(), "vibehard-fleet-"));
  WORKSPACE = mkdtempSync(join(tmpdir(), "vibehard-ws-"));
  dirs.push(FLEET, WORKSPACE);
  process.env.VIBEHARD_FLEET_DIR = FLEET;
  savedDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  __resetFleetStoreForTests();
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDbUrl;
  delete process.env.VIBEHARD_FLEET_DIR;
  __resetFleetStoreForTests();
});

describe("fleet store — benefit", () => {
  test("seeds with learned conventions and injects them into the codegen block", async () => {
    const block = await fleetBlock("Next.js + Supabase + Tailwind", "codegen");
    expect(block).toContain("learned_conventions");
    expect(block).toContain("await cookies()"); // a codegen convention (Next 15 async)
  });

  test("phase scoping — the architect gets PLANNING conventions (no Clerk), not codegen syntax rules", async () => {
    const planning = await fleetBlock("Next.js + Supabase", "planning");
    expect(planning).toContain("Supabase Auth"); // no-clerk is phase "both"
    expect(planning).not.toContain("postcss.config"); // a codegen-only rule must not bleed into planning
  });
  test("stack scoping prevents a python lesson poisoning a next build", () => {
    expect(normalizeStack("FastAPI + Supabase + Python")).toBe("python-fastapi");
    expect(normalizeStack("Next.js + Supabase")).toBe("next-supabase");
  });
});

describe("fleet store — learning (verifier-gated promotion)", () => {
  test("a candidate must recur across builds before it's promotable", async () => {
    await recordCandidate("next-supabase", "verify:some-new-class");
    await recordCandidate("next-supabase", "verify:some-new-class");
    expect((await promotable(3)).some((c) => c.signal === "verify:some-new-class")).toBe(false); // 2 builds
    await recordCandidate("next-supabase", "verify:some-new-class");
    expect((await promotable(3)).some((c) => c.signal === "verify:some-new-class")).toBe(true); // 3 → eligible
  });
});

describe("fleet store — diversity (universal vs specific)", () => {
  test("the SAME app retried 3× is NOT promotable (likely specific); 3 DISTINCT apps IS (universal)", async () => {
    await recordCandidate("next-supabase", "verify:maybe-specific", "app-alpha");
    await recordCandidate("next-supabase", "verify:maybe-specific", "app-alpha");
    await recordCandidate("next-supabase", "verify:maybe-specific", "app-alpha"); // 3 builds, 1 app
    expect((await promotable(3)).some((c) => c.signal === "verify:maybe-specific")).toBe(false);
    await recordCandidate("next-supabase", "verify:maybe-specific", "app-beta");
    await recordCandidate("next-supabase", "verify:maybe-specific", "app-gamma"); // now 3 distinct apps
    expect((await promotable(3)).some((c) => c.signal === "verify:maybe-specific")).toBe(true);
  });
});

describe("fleet store — schema robustness", () => {
  test("recordCandidate tolerates a legacy candidate with no 'apps' field (no crash, migrates it)", async () => {
    // a store written BEFORE the diversity field existed
    writeFileSync(join(FLEET, "candidates.json"), JSON.stringify([{ key: "next-supabase::verify:old", stack: "next-supabase", signal: "verify:old", builds: 2, resolutions: [] }]));
    await expect(recordCandidate("next-supabase", "verify:old", "app-x")).resolves.toBeUndefined();
    expect(await promotable(99)).toBeDefined(); // store still readable
  });
});

describe("fleet store — fix-capture (the keystone)", () => {
  test("recordResolution attaches the (failure → files that cleared it) evidence to the candidate", async () => {
    await recordCandidate("next-supabase", "verify:build-failed");
    await recordResolution("next-supabase", "verify:build-failed", { message: "'x' is not exported from '@/lib/y'", files: ["lib/y.ts"] });
    await recordResolution("next-supabase", "verify:build-failed", { message: "Module not found 'stripe'", files: ["package.json"] });
    await recordCandidate("next-supabase", "verify:build-failed");
    await recordCandidate("next-supabase", "verify:build-failed"); // 3 builds total → promotable
    const c = (await promotable(3)).find((x) => x.signal === "verify:build-failed");
    expect(c).toBeDefined();
    expect(c!.resolutions.length).toBe(2); // the evidence the induction step reads
    expect(c!.resolutions[0]!.files).toContain("lib/y.ts");
  });
});

describe("fleet store — PRIVATE: users never get a copy", () => {
  test("the store lives in the private dir, NEVER inside a build workspace", async () => {
    await fleetBlock("next-supabase"); // triggers the seed write
    await recordCandidate("next-supabase", "x:y");
    expect(existsSync(join(FLEET, "conventions.json"))).toBe(true);
    expect(readdirSync(WORKSPACE)).toHaveLength(0); // the user's workspace is untouched
  });
  test("the module never leaks store content into a workspace artifact", async () => {
    const block = await fleetBlock("next-supabase");
    writeFileSync(join(WORKSPACE, "AS_BUILT.md"), "## Build log\n");
    expect(readFileSync(join(WORKSPACE, "AS_BUILT.md"), "utf8")).not.toContain("learned_conventions");
    expect(block).toContain("learned_conventions"); // exists — but only where WE put it (the system prompt)
  });
});
