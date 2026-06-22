import { describe, expect, test } from "bun:test";
import { workstreamBrief } from "./workstream-brief.ts";
import type { Architecture } from "../architecture/index.ts";

const arch: Architecture = {
  prd: {
    spec: { name: "crm", summary: "a CRM", tenancy: "multi-tenant", auth: "email-password" },
    nfrs: ["Scope every RLS policy to the owning tenant."],
  } as unknown as Architecture["prd"],
  stack: "Next.js + Supabase",
  workstreams: [
    { name: "db", responsibility: "schema + RLS", files: ["supabase/migrations/001.sql"], dependsOn: [] },
    { name: "api", responsibility: "REST routes", files: ["app/api/route.ts"], dependsOn: ["db"] },
  ],
};

describe("workstreamBrief", () => {
  test("scopes the pass to one workstream, names prior work, and carries the NFRs", () => {
    const brief = workstreamBrief(arch, arch.workstreams[1]!, ["db"]);
    expect(brief).toContain('NOW generate ONLY the "api" workstream');
    expect(brief).toContain("app/api/route.ts");
    expect(brief).toContain("Already generated"); // knows db came first
    expect(brief).toContain("db");
    expect(brief).toContain("Scope every RLS policy"); // NFR carried in
    expect(brief).toContain("Stack: Next.js + Supabase");
  });

  test("the first workstream has no 'already generated' section", () => {
    const brief = workstreamBrief(arch, arch.workstreams[0]!, []);
    expect(brief).not.toContain("Already generated");
    expect(brief).toContain('NOW generate ONLY the "db" workstream');
  });
});
