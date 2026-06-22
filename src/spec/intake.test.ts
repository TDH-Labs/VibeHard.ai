import { describe, expect, test } from "bun:test";
import { planIntake, type Intake } from "./intake.ts";
import type { Spec } from "./spec.ts";

/** A ready, non-sensitive prototype spec (reviewSpec → no findings at all). */
const readySpec: Spec = {
  name: "converter",
  summary: "metric/imperial converter",
  features: ["convert length"],
  users: "anyone",
  tenancy: "single-user",
  auth: "none",
  storesData: false,
  dataEntities: [],
  sensitiveData: ["none"],
  realUsers: false,
  maintained: false,
};

/** A spec with a BLOCKING gap: sensitive + multi-tenant with no auth. */
const blockedSpec: Spec = {
  ...readySpec,
  name: "leaky",
  tenancy: "multi-tenant",
  storesData: true,
  dataEntities: [{ name: "patients", fields: ["id"], sensitive: true }],
  sensitiveData: ["phi"],
  auth: "none",
};

describe("planIntake — grill loop (LLM proposes, reviewSpec disposes)", () => {
  test("a ready first draft → one round, ready, no re-draft", async () => {
    let calls = 0;
    const intake: Intake = async () => {
      calls++;
      return readySpec;
    };
    const r = await planIntake("a converter", { intake });
    expect(r.ready).toBe(true);
    expect(r.rounds).toBe(1);
    expect(calls).toBe(1);
  });

  test("blocked, then fixed on the next pass → two rounds, ready", async () => {
    const drafts = [blockedSpec, { ...blockedSpec, auth: "email-password", name: "fixed" }];
    let i = 0;
    const intake: Intake = async (_p, prior) => {
      expect(i === 0 ? prior === null : prior !== null).toBe(true); // prior carried on refine
      return drafts[Math.min(i++, drafts.length - 1)]!;
    };
    const r = await planIntake("a clinic", { intake });
    expect(r.rounds).toBe(2);
    expect(r.ready).toBe(true);
    expect(r.spec.name).toBe("fixed");
  });

  test("never-fixable → stops at budget, NOT ready (the gate disposes — a bad draft can't force ready)", async () => {
    const intake: Intake = async () => blockedSpec; // always blocked
    const r = await planIntake("a clinic", { intake, budget: 3 });
    expect(r.rounds).toBe(3);
    expect(r.ready).toBe(false);
    expect(r.gaps.some((g) => g.ruleId === "no-auth-for-sensitive")).toBe(true);
  });

  test("budget is floored at 1 (always at least one draft)", async () => {
    let calls = 0;
    const intake: Intake = async () => {
      calls++;
      return blockedSpec;
    };
    const r = await planIntake("x", { intake, budget: 0 });
    expect(calls).toBe(1);
    expect(r.rounds).toBe(1);
  });
});
