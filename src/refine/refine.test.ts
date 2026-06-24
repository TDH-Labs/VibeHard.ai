import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spec } from "../spec/spec.ts";
import { appendRefinement, buildRefineBrief, listSourceFiles, refine, type RefineFix, type RefineGate, type RefineRegen } from "./refine.ts";

const BASE: Spec = {
  name: "Test App",
  summary: "a test app",
  features: ["a", "b"],
  users: "people",
  tenancy: "single-tenant",
  auth: "email-password",
  storesData: true,
  dataEntities: [],
  sensitiveData: ["none"],
  realUsers: true,
  maintained: true,
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeProject(spec: Spec = BASE): string {
  const dir = mkdtempSync(join(tmpdir(), "drydock-refine-test-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".drydock"), { recursive: true });
  writeFileSync(join(dir, ".drydock", "spec.json"), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, "app.js"), "original");
  return dir;
}

function readSpec(dir: string): Spec {
  return JSON.parse(readFileSync(join(dir, ".drydock", "spec.json"), "utf8")) as Spec;
}

/** A regen that modifies app.js and adds added.js — like an engine touching files. */
const regenTouch: RefineRegen = async (d) => {
  writeFileSync(join(d, "app.js"), "modified by refine");
  writeFileSync(join(d, "added.js"), "new file");
  return { ok: true, filesWritten: ["app.js", "added.js"] };
};

/** gate that returns the given pass values in order (last value repeats). */
function gateSeq(...passes: boolean[]): RefineGate {
  let i = 0;
  return async () => ({ verdicts: [], passed: passes[Math.min(i++, passes.length - 1)]! });
}

const fixFail: RefineFix = async () => ({ fixed: false, attempts: 1, finalVerdicts: [], escalation: null, log: [] });

describe("appendRefinement (pure)", () => {
  test("appends additively and trims, preserving features", () => {
    const out = appendRefinement(BASE, "  add logout  ", "2026-01-01T00:00:00Z");
    expect(out.refinements).toEqual([{ at: "2026-01-01T00:00:00Z", change: "add logout" }]);
    expect(out.features).toEqual(["a", "b"]);
    expect(BASE.refinements).toBeUndefined(); // original untouched
  });
  test("appends onto an existing trail", () => {
    const once = appendRefinement(BASE, "first", "t1");
    const twice = appendRefinement(once, "second", "t2");
    expect(twice.refinements?.map((r) => r.change)).toEqual(["first", "second"]);
  });
});

describe("buildRefineBrief (pure)", () => {
  test("includes the change, the file content, and a minimal-change instruction", () => {
    const brief = buildRefineBrief("add a footer", [{ path: "index.html", content: "<body></body>" }], BASE);
    expect(brief).toContain("add a footer");
    expect(brief).toContain("index.html");
    expect(brief).toContain("<body></body>");
    expect(brief).toContain("as FEW files as possible");
  });
});

describe("listSourceFiles", () => {
  test("excludes derived/meta dirs", () => {
    const dir = makeProject();
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x.js"), "dep");
    expect(listSourceFiles(dir)).toEqual(["app.js"]); // not node_modules/x.js, not .drydock/spec.json
  });
});

describe("refine orchestrator", () => {
  test("errors when there is no spec to refine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drydock-refine-nospec-"));
    dirs.push(dir);
    await expect(refine(dir, "anything", { regen: regenTouch, now: "t" })).rejects.toThrow(/spec\.json/);
  });

  test("errors on an empty change", async () => {
    const dir = makeProject();
    await expect(refine(dir, "   ", { regen: regenTouch, now: "t" })).rejects.toThrow(/empty/);
  });

  test("accepts when the post-refine gate passes; records the refinement", async () => {
    const dir = makeProject();
    const res = await refine(dir, "add logout", { regen: regenTouch, gate: gateSeq(true), now: "t" });
    expect(res.accepted).toBe(true);
    expect(res.restored).toBe(false);
    expect(res.filesWritten).toEqual(["app.js", "added.js"]);
    expect(readFileSync(join(dir, "app.js"), "utf8")).toBe("modified by refine");
    expect(existsSync(join(dir, "added.js"))).toBe(true);
    expect(readSpec(dir).refinements).toEqual([{ at: "t", change: "add logout" }]);
  });

  test("reverts a green→red refine and records NOTHING (the passing build is sacred)", async () => {
    const dir = makeProject();
    // baseline green, then red forever; auto-fix can't recover it.
    const res = await refine(dir, "break it", { regen: regenTouch, gate: gateSeq(true, false), fix: fixFail, now: "t" });
    expect(res.accepted).toBe(false);
    expect(res.restored).toBe(true);
    expect(res.wasGreen).toBe(true);
    expect(readFileSync(join(dir, "app.js"), "utf8")).toBe("original"); // modification reverted
    expect(existsSync(join(dir, "added.js"))).toBe(false); // added file removed
    expect(readSpec(dir).refinements).toBeUndefined(); // no phantom refinement
  });

  test("restores when the engine errors mid-refine on a previously-green build", async () => {
    const dir = makeProject();
    const regenFail: RefineRegen = async (d) => {
      writeFileSync(join(d, "app.js"), "half-written"); // partial damage
      return { ok: false, filesWritten: [] };
    };
    const res = await refine(dir, "x", { regen: regenFail, gate: gateSeq(true), now: "t" });
    expect(res.accepted).toBe(false);
    expect(res.restored).toBe(true);
    expect(readFileSync(join(dir, "app.js"), "utf8")).toBe("original");
  });

  test("restores a green build when the gate THROWS after regen, then rethrows", async () => {
    const dir = makeProject();
    let calls = 0;
    const gate: RefineGate = async () => {
      calls++;
      if (calls === 1) return { verdicts: [], passed: true }; // baseline green
      throw new Error("gate crashed"); // post-regen gate blows up
    };
    await expect(refine(dir, "x", { regen: regenTouch, gate, now: "t" })).rejects.toThrow(/gate crashed/);
    expect(readFileSync(join(dir, "app.js"), "utf8")).toBe("original"); // reverted despite the throw
    expect(existsSync(join(dir, "added.js"))).toBe(false);
    expect(readSpec(dir).refinements).toBeUndefined();
  });

  test("a green→red revert also removes engine writes into derived dirs", async () => {
    const dir = makeProject();
    const regenDerived: RefineRegen = async (d) => {
      writeFileSync(join(d, "app.js"), "modified");
      mkdirSync(join(d, "dist"), { recursive: true });
      writeFileSync(join(d, "dist", "bad.js"), "stray build output");
      return { ok: true, filesWritten: ["app.js", "dist/bad.js"] };
    };
    const res = await refine(dir, "x", { regen: regenDerived, gate: gateSeq(true, false), fix: fixFail, now: "t" });
    expect(res.restored).toBe(true);
    expect(existsSync(join(dir, "dist", "bad.js"))).toBe(false); // derived write removed
    expect(existsSync(join(dir, "dist"))).toBe(false); // emptied dir pruned
    expect(readFileSync(join(dir, "app.js"), "utf8")).toBe("original");
  });

  test("accepts on an already-broken build (no green to protect)", async () => {
    const dir = makeProject();
    const res = await refine(dir, "try anyway", { regen: regenTouch, gate: gateSeq(false), fix: fixFail, now: "t" });
    expect(res.accepted).toBe(true);
    expect(res.restored).toBe(false);
    expect(res.wasGreen).toBe(false);
    expect(readSpec(dir).refinements).toEqual([{ at: "t", change: "try anyway" }]);
  });
});
