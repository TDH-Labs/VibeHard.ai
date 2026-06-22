import { describe, expect, test } from "bun:test";
import { buildGenerationBrief, securityRequirements } from "./brief.ts";
import type { Prd } from "./prd.ts";

function prd(over: Partial<Prd> = {}): Prd {
  return {
    name: "app",
    summary: "an app",
    features: ["do a thing"],
    users: "people",
    tenancy: "multi-tenant",
    auth: "email-password",
    storesData: true,
    dataEntities: [{ name: "records", fields: ["id", "user_id"], sensitive: true }],
    sensitiveData: ["pii"],
    realUsers: true,
    maintained: true,
    ...over,
  };
}

describe("securityRequirements — the spec's posture becomes codegen rules that pre-empt gates", () => {
  test("multi-tenant + sensitive → per-tenant RLS, no using(true)/authenticated, auth, parameterized, secrets, no-log", () => {
    const reqs = securityRequirements(prd()).join("\n");
    expect(reqs).toMatch(/Row-Level Security/i);
    expect(reqs).toMatch(/auth\.uid\(\) = user_id/); // owner-scoped
    expect(reqs).toMatch(/Do NOT use `using \(true\)` or `auth\.uid\(\) is not null`/); // pre-empts the rls findings
    expect(reqs).toMatch(/Require authentication/i);
    expect(reqs).toMatch(/parameterized queries/i); // pre-empts SQLi
    expect(reqs).toMatch(/environment variables/i); // pre-empts secrets
    expect(reqs).toMatch(/Never log sensitive/i);
  });

  test("single-user sensitive → owner-scoped RLS, but not the multi-tenant phrasing", () => {
    const reqs = securityRequirements(prd({ tenancy: "single-user" })).join("\n");
    expect(reqs).toMatch(/auth\.uid\(\) = user_id/);
    expect(reqs).not.toMatch(/auth\.uid\(\) is not null/); // the multi-tenant-only warning
  });

  test("a static, no-data, no-auth app → no security requirements at all", () => {
    const converter = prd({
      tenancy: "single-user",
      auth: "none",
      storesData: false,
      dataEntities: [],
      sensitiveData: ["none"],
    });
    expect(securityRequirements(converter)).toEqual([]);
  });

  test("non-sensitive app that stores data → parameterized + secrets, but no RLS", () => {
    const reqs = securityRequirements(prd({ sensitiveData: ["none"], dataEntities: [{ name: "t", fields: ["a"], sensitive: false }] })).join("\n");
    expect(reqs).toMatch(/parameterized queries/i);
    expect(reqs).not.toMatch(/Row-Level Security/i);
  });
});

describe("buildGenerationBrief", () => {
  test("includes the spec (summary, features, data model) and the security section", () => {
    const brief = buildGenerationBrief(prd());
    expect(brief).toContain("an app");
    expect(brief).toContain("- do a thing");
    expect(brief).toContain("records(id, user_id)  [sensitive]");
    expect(brief).toContain("SECURITY REQUIREMENTS");
  });

  test("a trivial app omits the security section entirely", () => {
    const brief = buildGenerationBrief(prd({ auth: "none", storesData: false, dataEntities: [], sensitiveData: ["none"], tenancy: "single-user" }));
    expect(brief).not.toContain("SECURITY REQUIREMENTS");
  });
});
