import { describe, expect, test } from "bun:test";
import { decideRigor, isSensitive, prdVerdict, reviewPrd, type Prd } from "./prd.ts";

/** A sound, production-grade multi-tenant PRD (the "should pass" baseline). */
function prd(over: Partial<Prd> = {}): Prd {
  return {
    name: "notes",
    summary: "Per-user notes. Data is retained until the user deletes it.",
    features: ["sign in", "create note", "list own notes"],
    users: "individuals",
    tenancy: "multi-tenant",
    auth: "email-password",
    storesData: true,
    dataEntities: [{ name: "notes", fields: ["id", "user_id", "body"], sensitive: true }],
    sensitiveData: ["pii"],
    realUsers: true,
    maintained: true,
    ...over,
  };
}

const ruleIds = (prd: Prd) => reviewPrd(prd).map((f) => f.ruleId);

describe("reviewPrd — blocking readiness gaps", () => {
  test("a sound spec yields no BLOCKING gaps (only the advisory tenant-isolation heads-up)", () => {
    const v = prdVerdict(prd(), "2026-06-21T00:00:00.000Z");
    expect(v.status).toBe("pass"); // advisories don't block; the spec is buildable
    expect(v.findings.filter((f) => f.severity === "high" || f.severity === "critical")).toEqual([]);
    expect(v.findings.map((f) => f.ruleId)).toEqual(["tenant-isolation-required"]);
  });

  test("no features → blocking", () => {
    expect(ruleIds(prd({ features: [] }))).toContain("no-features");
    expect(prdVerdict(prd({ features: [] })).status).toBe("block");
  });

  test("stores data but no data model → blocking", () => {
    expect(ruleIds(prd({ storesData: true, dataEntities: [] }))).toContain("no-data-model");
  });

  test("sensitive/multi-tenant with no auth → CRITICAL block", () => {
    const f = reviewPrd(prd({ auth: "none" })).find((x) => x.ruleId === "no-auth-for-sensitive");
    expect(f?.severity).toBe("critical");
    expect(prdVerdict(prd({ auth: "none" })).status).toBe("block");
  });

  test("multi-tenant + sensitive PREDICTS the rls gate (tenant-isolation-required)", () => {
    const ids = ruleIds(prd());
    expect(ids).toContain("tenant-isolation-required");
    // single-tenant sensitive data does NOT trigger the tenant-isolation prediction
    expect(ruleIds(prd({ tenancy: "single-user" }))).not.toContain("tenant-isolation-required");
  });
});

describe("reviewPrd — advisory gaps (surface, do not block)", () => {
  test("sensitive data with no retention/deletion mention → advisory medium", () => {
    const p = prd({ summary: "Per-user notes." }); // no delete/retention words
    const f = reviewPrd(p).find((x) => x.ruleId === "no-retention-plan");
    expect(f?.severity).toBe("medium");
    // advisory does not block on its own
    expect(prdVerdict(prd({ summary: "Per-user notes.", tenancy: "single-user" })).status).toBe("pass");
  });

  test("entity flagged sensitive but classification empty → advisory low", () => {
    const p = prd({ sensitiveData: ["none"], dataEntities: [{ name: "x", fields: ["a"], sensitive: true }] });
    expect(ruleIds(p)).toContain("sensitive-classification-gap");
  });

  test("a non-sensitive throwaway with a feature has no gaps at all", () => {
    const p: Prd = {
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
    expect(reviewPrd(p)).toEqual([]);
  });
});

describe("decideRigor — §16 adaptive rigor", () => {
  test("real users / maintained / sensitive → production", () => {
    expect(decideRigor(prd({ realUsers: true, maintained: false, sensitiveData: ["none"], dataEntities: [] }))).toBe("production");
    expect(decideRigor(prd({ realUsers: false, maintained: true, sensitiveData: ["none"], dataEntities: [] }))).toBe("production");
    expect(decideRigor(prd({ realUsers: false, maintained: false, sensitiveData: ["pii"] }))).toBe("production");
  });

  test("a throwaway with none of the signals → prototype (skip the ceremony)", () => {
    const p = prd({ realUsers: false, maintained: false, sensitiveData: ["none"], dataEntities: [{ name: "x", fields: ["a"], sensitive: false }] });
    expect(isSensitive(p)).toBe(false);
    expect(decideRigor(p)).toBe("prototype");
  });
});

describe("§16 compliance guard — PRD gaps never claim certification", () => {
  test("no readiness message says compliant/certified", () => {
    const variants = [prd(), prd({ auth: "none" }), prd({ summary: "x", features: [] }), prd({ sensitiveData: ["phi"], summary: "phi data" })];
    for (const p of variants) {
      for (const f of reviewPrd(p)) {
        expect(f.message.toLowerCase()).not.toMatch(/\b(compliant|certified|certification|hipaa-ready|soc ?2 ?(ready|compliant))\b/);
      }
    }
  });
});
