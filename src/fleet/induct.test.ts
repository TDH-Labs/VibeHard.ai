import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveConvention, coerceConvention, pendingConventions, runInduction } from "./induct.ts";
import { loadConventions, recordCandidate, recordResolution, type Candidate } from "./fleet.ts";

let FLEET: string;
let FIX: string;
const dirs: string[] = [];
beforeEach(() => {
  FLEET = mkdtempSync(join(tmpdir(), "vibehard-fleet-"));
  FIX = mkdtempSync(join(tmpdir(), "vibehard-fix-"));
  dirs.push(FLEET, FIX);
  process.env.VIBEHARD_FLEET_DIR = FLEET;
  process.env.VIBEHARD_FIXTURES_DIR = FIX;
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.VIBEHARD_FLEET_DIR;
  delete process.env.VIBEHARD_FIXTURES_DIR;
});

const cand = (over: Partial<Candidate> = {}): Candidate => ({ key: "next-supabase::verify:x", stack: "next-supabase", signal: "verify:x", builds: 3, resolutions: [], ...over });

describe("coerceConvention (trust boundary)", () => {
  test("valid proposal → a Convention scoped/addressed from the candidate", () => {
    const c = coerceConvention({ id: "await-foo", rule: "Always await foo() before using it.", phase: "codegen" }, cand());
    expect(c).toEqual({ id: "await-foo", stack: "next-supabase", phase: "codegen", rule: "Always await foo() before using it.", addresses: "verify:x", builds: 3 });
  });
  test("too-short / garbage rule → null (nothing promoted)", () => {
    expect(coerceConvention({ rule: "no" }, cand())).toBeNull();
    expect(coerceConvention("nonsense", cand())).toBeNull();
  });
  test("bad phase → defaults to codegen; missing id → derived", () => {
    const c = coerceConvention({ rule: "A sufficiently long actionable rule about X." }, cand())!;
    expect(c.phase).toBe("codegen");
    expect(c.id.length).toBeGreaterThan(0);
  });
});

describe("induction pipeline (verifier-gated, review-queued)", () => {
  test("only promotable candidates are induced, and proposals go to PENDING — never auto-live", async () => {
    // a candidate that recurred 3× with fix evidence (verifier-gated)
    recordResolution("next-supabase", "verify:new-thing", { message: "boom", files: ["lib/a.ts"] });
    recordCandidate("next-supabase", "verify:new-thing");
    recordCandidate("next-supabase", "verify:new-thing");
    recordCandidate("next-supabase", "verify:new-thing");

    const before = loadConventions().length;
    const fakeInductor = async () => ({ id: "fix-new-thing", stack: "next-supabase", phase: "codegen" as const, rule: "Do the thing that prevents new-thing failures.", addresses: "verify:new-thing", builds: 3 });
    const proposed = await runInduction({ inductor: fakeInductor });

    expect(proposed.map((p) => p.id)).toContain("fix-new-thing");
    expect(pendingConventions().some((p) => p.id === "fix-new-thing")).toBe(true);
    expect(loadConventions().length).toBe(before); // NOT live yet — operator must approve
  });

  test("approve → goes live AND drops a regression fixture (the harness lock)", async () => {
    const fakeInductor = async () => ({ id: "fix-it", stack: "next-supabase", phase: "codegen" as const, rule: "A real actionable convention.", addresses: "verify:z", builds: 3 });
    recordResolution("next-supabase", "verify:z", { message: "x", files: ["a.ts"] });
    recordCandidate("next-supabase", "verify:z");
    recordCandidate("next-supabase", "verify:z");
    recordCandidate("next-supabase", "verify:z");
    await runInduction({ inductor: fakeInductor });

    const approved = approveConvention("fix-it");
    expect(approved?.id).toBe("fix-it");
    expect(loadConventions().some((c) => c.id === "fix-it")).toBe(true); // now live
    expect(pendingConventions().some((p) => p.id === "fix-it")).toBe(false); // out of the queue
    expect(existsSync(join(FIX, "learned-fix-it.log"))).toBe(true); // regression fixture dropped
  });
});
