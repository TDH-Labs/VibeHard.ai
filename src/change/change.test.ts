import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceDelta, llmChangeDelta, persistChange, validateDelta, type ChangeDelta } from "./delta.ts";
import { blastRadius } from "./blast.ts";
import { applyDeltaToPrd, applyDeltaToSpec, buildChangeBrief, dropPropertyTests, nextRequirementId, staleRequirementIds } from "./apply.ts";
import { listVersions, rollbackToVersion, snapshotVersion } from "./snapshot.ts";
import type { Spec } from "../spec/index.ts";
import type { Prd, Requirement } from "../prd/index.ts";
import type { Architecture } from "../architecture/index.ts";
import type { Srs } from "../srs/index.ts";
import { PROPTEST_DIR, propTestFileName } from "../proptest/validate.ts";

const NOW = "2026-01-01T00:00:00Z";
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-change-"));
  tmps.push(d);
  return d;
}

function spec(): Spec {
  return {
    name: "paw", summary: "dog grooming waitlist", features: ["join the waitlist", "owner sign-in"],
    users: "groomers", tenancy: "multi-tenant", deployTarget: "hosted-app", auth: "email-password", storesData: true,
    dataEntities: [{ name: "waitlist", fields: ["id"], sensitive: true }], sensitiveData: ["pii"], realUsers: true, maintained: true,
  };
}
const req = (id: string, feature: string): Requirement => ({ id, feature, detail: "d", acceptance: ["checkable"], priority: "MVP", scenarioRefs: [] });
function prd(): Prd {
  return {
    spec: spec(), status: "in-review", title: "PRD", overview: "", problemStatement: "", objectives: [], constraints: [],
    personas: [], scenarios: [], requirements: [req("F1", "join the waitlist"), req("F2", "owner sign-in")],
    outOfScope: [], successMetrics: [], risks: [], openQuestions: [], nfrs: [], buyVsBuild: [],
  } as unknown as Prd;
}
function srs(): Srs {
  return {
    functionalRequirements: [
      { id: "FR-1", title: "join", description: "", actor: "visitor", covers: ["F1"], inputs: [], outputs: [], workflow: [], errors: [] },
      { id: "FR-2", title: "signin", description: "", actor: "owner", covers: ["F2"], inputs: [], outputs: [], workflow: [], errors: [] },
    ],
  } as unknown as Srs;
}
function arch(): Architecture {
  return {
    stack: "Next.js + Supabase",
    workstreams: [
      { name: "waitlist", responsibility: "join flow", files: ["app/page.tsx", "lib/waitlist.ts"], dependsOn: [], covers: ["FR-1"] },
      { name: "auth-ui", responsibility: "owner sign-in", files: ["app/owner/page.tsx"], dependsOn: [], covers: ["FR-2"] },
    ],
  } as unknown as Architecture;
}
const delta = (over: Partial<ChangeDelta> = {}): ChangeDelta => ({
  request: "let people pick a groomer", summary: "add groomer picker", add: [], modify: [], remove: [], at: NOW, ...over,
});

describe("delta — coerce + validate (deterministic dispose)", () => {
  test("modify/remove must name existing features EXACTLY", () => {
    const bad = delta({ modify: [{ feature: "the waitlist", change: "x" }], remove: ["signin"] });
    const problems = validateDelta(bad, spec());
    expect(problems.some((p) => p.includes('"the waitlist"'))).toBe(true);
    expect(problems.some((p) => p.includes('"signin"'))).toBe(true);
  });

  test("added features need acceptance criteria; duplicates are refused; empty deltas are refused", () => {
    expect(validateDelta(delta({ add: [{ feature: "pick a groomer", acceptance: [] }] }), spec()).some((p) => p.includes("acceptance"))).toBe(true);
    expect(validateDelta(delta({ add: [{ feature: "join the waitlist", acceptance: ["x"] }] }), spec()).some((p) => p.includes("duplicates"))).toBe(true);
    expect(validateDelta(delta(), spec()).some((p) => p.includes("no actionable change"))).toBe(true);
  });

  test("a coherent delta validates clean", () => {
    const good = delta({ add: [{ feature: "pick a groomer", acceptance: ["a visitor can choose a groomer when joining"] }], modify: [{ feature: "join the waitlist", change: "also collect the dog's breed" }] });
    expect(validateDelta(good, spec())).toEqual([]);
  });

  test("llmChangeDelta coerces model output through the trust boundary", async () => {
    const d = await llmChangeDelta("collect breed too", spec(), NOW, {
      generate: async () => JSON.stringify({ summary: "collect breed", modify: [{ feature: "join the waitlist", change: "collect breed" }], add: [], remove: [] }),
    });
    expect(d.modify).toEqual([{ feature: "join the waitlist", change: "collect breed" }]);
    expect(coerceDelta({ add: [{ feature: "  x  ", acceptance: ["a", ""] }] }, "r", NOW).add).toEqual([{ feature: "x", acceptance: ["a"] }]);
  });

  test("persistChange appends numbered audit records", () => {
    const d = dir();
    expect(persistChange(d, delta())).toBe(join(".vibehard", "changes", "1.json"));
    expect(persistChange(d, delta())).toBe(join(".vibehard", "changes", "2.json"));
    expect(JSON.parse(readFileSync(join(d, ".vibehard/changes/1.json"), "utf8")).request).toContain("groomer");
  });
});

describe("blastRadius — the deterministic traceability walk", () => {
  test("modified feature → F-id → FR-id → workstream → files; untouched workstreams stay out", () => {
    const b = blastRadius(delta({ modify: [{ feature: "join the waitlist", change: "x" }] }), prd(), srs(), arch());
    expect(b.requirementIds).toEqual(["F1"]);
    expect(b.workstreams).toEqual(["waitlist"]);
    expect(b.files).toEqual(["app/page.tsx", "lib/waitlist.ts"]);
    expect(b.unmapped).toEqual([]);
  });

  test("falls back to F-ids in workstream.covers when no SRS exists", () => {
    const a = arch();
    a.workstreams[0]!.covers = ["F1"];
    const b = blastRadius(delta({ modify: [{ feature: "join the waitlist", change: "x" }] }), prd(), null, a);
    expect(b.workstreams).toEqual(["waitlist"]);
  });

  test("a feature nothing covers is reported unmapped, never dropped", () => {
    const p = prd();
    p.requirements = p.requirements.filter((r) => r.id !== "F2");
    const b = blastRadius(delta({ remove: ["owner sign-in"] }), p, srs(), arch());
    expect(b.unmapped).toEqual(["owner sign-in"]);
  });
});

describe("apply — pure artifact updates", () => {
  test("spec features: removed go, added come, modified stay", () => {
    const s = applyDeltaToSpec(spec(), delta({ remove: ["owner sign-in"], add: [{ feature: "pick a groomer", acceptance: ["x"] }] }));
    expect(s.features).toEqual(["join the waitlist", "pick a groomer"]);
  });

  test("PRD: removal drops the requirement; modify appends the change and can replace acceptance; add creates the next F-id", () => {
    const p = applyDeltaToPrd(prd(), delta({
      remove: ["owner sign-in"],
      modify: [{ feature: "join the waitlist", change: "collect breed", acceptance: ["breed is required to join"] }],
      add: [{ feature: "pick a groomer", acceptance: ["a visitor can choose a groomer"] }],
    }));
    expect(p.requirements.map((r) => r.id)).toEqual(["F1", "F3"]);
    expect(p.requirements[0]!.detail).toContain("CHANGED: collect breed");
    expect(p.requirements[0]!.acceptance).toEqual(["breed is required to join"]);
    expect(p.requirements[1]!.feature).toBe("pick a groomer");
    expect(p.requirements[1]!.priority).toBe("MVP");
  });

  test("nextRequirementId skips non-F ids and gaps", () => {
    expect(nextRequirementId([req("F1", "a"), req("F7", "b"), req("REQ-9", "c")])).toBe("F8");
  });

  test("stale property tests are dropped by requirement id — modified and removed, not others", () => {
    const d = dir();
    mkdirSync(join(d, PROPTEST_DIR), { recursive: true });
    for (const id of ["F1", "F2"]) writeFileSync(join(d, PROPTEST_DIR, propTestFileName(id)), "// x");
    const stale = staleRequirementIds(prd(), delta({ modify: [{ feature: "join the waitlist", change: "x" }] }));
    expect(stale).toEqual(["F1"]);
    expect(dropPropertyTests(d, stale)).toEqual([join(PROPTEST_DIR, "f1.test.ts")]);
    expect(existsSync(join(d, PROPTEST_DIR, "f2.test.ts"))).toBe(true);
  });

  test("the change brief carries the delta, the scope files' content, and the guardrails", () => {
    const d = dir();
    writeFileSync(join(d, "app-page.txt"), "x"); // not read — brief lists arch paths
    mkdirSync(join(d, "app"), { recursive: true });
    writeFileSync(join(d, "app/page.tsx"), "export default function P(){return null}");
    const brief = buildChangeBrief(d, delta({ modify: [{ feature: "join the waitlist", change: "collect breed" }] }), { requirementIds: ["F1"], workstreams: ["waitlist"], files: ["app/page.tsx", "lib/waitlist.ts"], unmapped: [] });
    expect(brief).toContain("CHANGE REQUEST against an existing");
    expect(brief).toContain("collect breed");
    expect(brief).toContain("--- app/page.tsx ---");
    expect(brief).toContain("not on disk"); // lib/waitlist.ts missing
    expect(brief).toContain("never edit anything under tests/properties/");
  });
});

describe("snapshot / rollback", () => {
  test("snapshot → break the app → rollback restores source AND front-half artifacts, deletes added files", () => {
    const d = dir();
    mkdirSync(join(d, ".vibehard"), { recursive: true });
    mkdirSync(join(d, "lib"), { recursive: true });
    writeFileSync(join(d, "lib/waitlist.ts"), "export const ok = true;");
    writeFileSync(join(d, ".vibehard/spec.json"), JSON.stringify({ features: ["join the waitlist"] }));
    expect(listVersions(d)).toEqual([]);
    const v = snapshotVersion(d);
    expect(v).toBe(1);
    // the "change": edit a file, add a file, rewrite the spec
    writeFileSync(join(d, "lib/waitlist.ts"), "export const ok = false;");
    writeFileSync(join(d, "lib/groomers.ts"), "export const g = 1;");
    writeFileSync(join(d, ".vibehard/spec.json"), JSON.stringify({ features: ["join", "pick"] }));
    expect(rollbackToVersion(d)).toBe(1);
    expect(readFileSync(join(d, "lib/waitlist.ts"), "utf8")).toContain("ok = true");
    expect(existsSync(join(d, "lib/groomers.ts"))).toBe(false);
    expect(JSON.parse(readFileSync(join(d, ".vibehard/spec.json"), "utf8")).features).toEqual(["join the waitlist"]);
  });

  test("snapshots never include node_modules/.gate; rollback with no snapshots is a null no-op", () => {
    const d = dir();
    mkdirSync(join(d, "node_modules/x"), { recursive: true });
    mkdirSync(join(d, ".gate"), { recursive: true });
    writeFileSync(join(d, "a.ts"), "1");
    snapshotVersion(d);
    expect(existsSync(join(d, ".vibehard/versions/1/node_modules"))).toBe(false);
    expect(existsSync(join(d, ".vibehard/versions/1/.gate"))).toBe(false);
    expect(rollbackToVersion(dir())).toBeNull();
  });

  test("versions accumulate and a specific one can be restored", () => {
    const d = dir();
    writeFileSync(join(d, "a.ts"), "v1");
    snapshotVersion(d);
    writeFileSync(join(d, "a.ts"), "v2");
    snapshotVersion(d);
    writeFileSync(join(d, "a.ts"), "v3");
    expect(listVersions(d)).toEqual([1, 2]);
    expect(rollbackToVersion(d, 1)).toBe(1);
    expect(readFileSync(join(d, "a.ts"), "utf8")).toBe("v1");
  });
});
