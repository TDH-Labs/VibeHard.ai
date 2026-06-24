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
    { name: "db", responsibility: "schema + RLS", files: ["supabase/migrations/001.sql"], dependsOn: [], covers: [] },
    { name: "api", responsibility: "REST routes", files: ["app/api/route.ts"], dependsOn: ["db"], covers: [] },
  ],
  systemOverview: "a CRM",
  architecturalGoals: [],
  pattern: { name: "modular monolith", rationale: "fits the substrate", tradeoffs: "less ultimate scalability" },
  dataFlow: "REST",
  dataArchitecture: { storageRationale: "", schema: "", stateManagement: "" },
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

  test("threads the covered SRS requirements + the SAD schema into the brief (the reviewed design drives codegen)", () => {
    const withDesign: Architecture = {
      ...arch,
      srs: {
        functionalRequirements: [
          {
            id: "FR-1",
            title: "Create client",
            description: "therapist adds a client",
            inputs: [{ element: "name", type: "string", constraints: "required", source: "body" }],
            outputs: [{ element: "client", type: "JSON", constraints: "", source: "db" }],
            workflow: ["validate", "insert"],
            errors: [{ condition: "missing name", action: "reject", response: "400" }],
          },
        ],
      } as unknown as Architecture["srs"],
      dataArchitecture: { storageRationale: "", schema: "create table client (id uuid primary key);\nalter table client enable row level security;", stateManagement: "" },
      workstreams: [
        { name: "db", responsibility: "schema + RLS", files: ["supabase/migrations/001.sql"], dependsOn: [], covers: [] },
        { name: "api", responsibility: "REST routes", files: ["app/api/route.ts"], dependsOn: ["db"], covers: ["FR-1"] },
      ],
    };
    // the API workstream (covers FR-1) gets the contract + the schema as REFERENCE
    const apiBrief = workstreamBrief(withDesign, withDesign.workstreams[1]!, ["db"]);
    expect(apiBrief).toContain("FR-1 — Create client");
    expect(apiBrief).toContain("inputs: name (string, required)");
    expect(apiBrief).toContain("errors: missing name → 400");
    expect(apiBrief).toContain("Reference — the database schema");
    expect(apiBrief).toContain("create table client");
    // the migration workstream is told to IMPLEMENT the exact schema; it covers no FR
    const dbBrief = workstreamBrief(withDesign, withDesign.workstreams[0]!, []);
    expect(dbBrief).toContain("Implement THIS EXACT database schema");
    expect(dbBrief).toContain("enable row level security");
    expect(dbBrief).not.toContain("FR-1");
  });
});
