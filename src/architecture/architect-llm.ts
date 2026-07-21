/**
 * The live `Architect` (stage 4 of the front-half): an LLM acting as a Software Architect turns
 * the SRS (and PRD) into a Software Architecture Document — system overview + goals, the pattern
 * + rationale + trade-offs, the component decomposition (workstreams + dependency graph + the SRS
 * requirements each covers), data flow, and a data architecture (storage rationale + schema DDL).
 * `coerceArchitecture` forces its JSON through the trust boundary; `reviewArchitecture` (in the
 * loop) validates the graph + SAD completeness + traceability. The §5 security/infra + §4 storage
 * facts are DERIVED at render time (§11). The model proposes the design; the deterministic checks
 * + topological build order are ours.
 */
import { configForStage } from "../config/models.ts";
import { tryExtractJsonObject } from "../spec/index.ts";
import { isBlocking } from "../types.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, generateTextResilient, type ModelFactory } from "../engine/bolt/driver.ts";
import type { Prd } from "../prd/index.ts";
import type { Srs } from "../srs/index.ts";
import { coerceArchitecture } from "./architecture.ts";
import type { Architect } from "./architect.ts";
import { fleetBlock } from "../fleet/fleet.ts";
import type { AppTemplate } from "../build/template.ts";

const ARCHITECT_SYSTEM_PROMPT = `# Role
You are an expert Software Architect. You turn a Software Requirements Specification (SRS) — which flows from a PRD and Spec — into a Software Architecture Document (SAD): the stack, the components (WORKSTREAMS, each owning files with a dependency graph), and the architectural decisions. Output a single JSON object — no prose, no markdown fence.

# Input analysis (do this first)
1. Map every SRS functional requirement (FR-…) to one or more components.
2. Map the non-functional requirements (performance, security, retention) to architectural / infrastructure choices.
3. Carry any SRS gaps that affect the architecture as constraints.

# Output schema
{
  "systemOverview": string,                          // §1 high-level description of the system
  "architecturalGoals": [ string ],                  // §1 guiding principles (e.g. fail-closed security, tenant isolation)
  "stack": string,                                   // e.g. "Next.js + Supabase + TypeScript + Tailwind"
  "pattern": { "name": string, "rationale": string, "tradeoffs": string },                 // §2 — WHY this pattern + what is sacrificed
  "dataFlow": string,                                // §3 how components communicate (REST / Pub-Sub / IPC / RLS-scoped client)
  "dataArchitecture": { "storageRationale": string, "schema": string, "stateManagement": string },   // §4 — schema = SQL DDL for core entities
  "dataModel": {                                     // §4b — STRUCTURED model; a deterministic generator turns this into migrations+RLS+auth (so get it right, not the prose DDL)
    "tenantEntity": string,                          // the tenant root table, e.g. "Center" (omit for single-user apps)
    "membershipEntity": string,                      // the table linking a login to a tenant+role, e.g. "Staff" (needed for tenant scoping)
    "tenantField": string,                           // tenant FK column name, e.g. "centerId"
    "roleField": string, "adminRole": string,        // e.g. "role", "admin"
    "entities": [ { "name": string, "access": "owner|tenant|tenant-admin|auth|public",
                    "fields": [ { "name": string, "type": "uuid|text|text[]|integer|numeric|boolean|timestamptz|date|jsonb", "nullable": boolean, "references": string } ] } ]
  },
  "workstreams": [ { "name": string, "responsibility": string, "files": [string], "dependsOn": [string], "covers": ["FR-1"] } ]
}

# Rules
- TRACEABILITY (§6): every SRS functional requirement id (FR-1, FR-2…) MUST appear in the "covers" of at least one workstream. A single component may cover several FRs.
- The workstream dependency graph MUST be acyclic (typical order: data/schema → server/api → ui). Every workstream owns >=1 file. "dependsOn" may only name other workstreams in the list.
- DEPLOYMENT CONSTRAINT (hard, branches on stack_hint.deployTarget and stack_hint.clientOnlyStorage):
  - deployTarget "hosted-app" + clientOnlyStorage true: a hosted app with NO server-side data at all — everything persists in the browser (localStorage/IndexedDB) only, nothing to sync or share. Do NOT propose Supabase, any other hosted/cloud database, migrations, RLS, or auth. "dataModel.entities" MUST be empty — there is no server data model. "stack" should name a purely static/client-side stack (e.g. "Next.js (static export) + TypeScript + Tailwind" or "Vite + React + TypeScript"). Deploy as a static Vercel app or a single Dockerfile serving static files — no database layer of any kind.
  - deployTarget "hosted-app" + clientOnlyStorage false (default): the data layer MUST be Supabase (Postgres + Row-Level Security) — the security boundary the platform verifies live before deploy. Do NOT use MongoDB, Firebase, MySQL, DynamoDB, PlanetScale, SQLite, or a self-managed Postgres (pg/Prisma/TypeORM/Knex/Drizzle). Deploy as EITHER a Vercel app (Next.js / Vite / static) OR a single Dockerfile container (e.g. FastAPI on Fly).
  - deployTarget "downloadable-tool": this is NOT a hosted app — it runs on the user's own machine, invoked from a terminal; nobody reaches it over a URL. Do NOT propose Supabase, any other hosted/cloud database, a Dockerfile, or ANY deploy/hosting artifact. The data layer (if the app stores data at all) is local: a local SQLite file for anything relational, or plain local JSON/file-based storage for simple flat records. "stack" should name a local runtime (e.g. "Node.js + TypeScript + Ink (TUI) + SQLite" or "Node.js + TypeScript (CLI) + local JSON store"), never a hosting platform.
- §2 pattern: give the rationale (from the SRS constraints) AND state the trade-offs explicitly. §4 dataArchitecture.schema: a concise SQL DDL for the core entities (derive from the SRS data model; include the RLS-relevant owner columns).
- §4b dataModel: emit the STRUCTURED model for every persisted entity — its access policy (owner = a user's own rows; tenant = any member of the tenant; tenant-admin = members read, admins write; auth = any logged-in user; public = world-readable) and typed fields with FK \`references\`. A tenant-scoped entity MUST include its tenant FK field (e.g. centerId references the tenant entity). This drives the generated migrations/RLS — be precise; don't restate the prose DDL here.
- BE CONCISE so the whole JSON fits in one response: short phrases, a focused DDL, 3-7 workstreams. A truncated document is a failed document.
- If given previous gaps, FIX every one (break a cycle, add files or covers, move the data layer to Supabase, supply the missing pattern rationale, …).`;

/** Phase 1 (golden templates): when a vendored template scaffolds this build, the architect is
 *  TOLD the skeleton exists — it plans features only. The prompt is a hint; the enforcement is
 *  reviewArchitecture's template-owned-path check + the cli's workstream pruning. */
export function architectTemplateBlock(tpl: AppTemplate): string {
  return `

# Project skeleton (VENDORED — already exists, do NOT plan it)
This build starts from a verified, pinned-dependency template. Its stack is fixed: "${tpl.stack}" — output exactly that as "stack".
The skeleton files already exist before any codegen: package.json (+ lockfile), tsconfig.json, next.config.mjs, postcss.config.mjs, tailwind.config.ts, app/layout.tsx, app/globals.css, README.md, Dockerfile${tpl.key === "next-static-client-only" ? ", server.js (static-file container entry)" : ", .env.example"}.
- Do NOT create a "Project Setup"/scaffolding workstream. Do NOT assign ANY skeleton file above to a workstream — nor variants of them (next.config.js, tailwind.config.js, postcss.config.js, styles/globals.css, pages/_app.tsx, a Dockerfile, a lockfile).
- Plan FEATURE work only: pages under app/ (Next.js App Router — a feature workstream SHOULD own app/page.tsx; NEVER plan a pages/ directory), components/, hooks/, lib/.`;
}

export interface LlmArchitectOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
  /** Golden template scaffolding this build (Phase 1) — null/undefined = no template. */
  template?: AppTemplate | null;
}

export function llmArchitect(opts: LlmArchitectOptions = {}): Architect {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config: EngineConfig =
    opts.config ??
    configForStage("sad");

  return async (prd: Prd, prior, srs?: Srs) => {
    const summary = {
      name: prd.spec.name,
      stack_hint: { tenancy: prd.spec.tenancy, auth: prd.spec.auth, storesData: prd.spec.storesData, clientOnlyStorage: prd.spec.clientOnlyStorage === true, deployTarget: prd.spec.deployTarget },
      // Design against the SRS when it ran (its FR ids drive the "covers" traceability); else the PRD.
      functionalRequirements: srs ? srs.functionalRequirements.map((f) => ({ id: f.id, title: f.title })) : prd.requirements.map((r) => ({ id: r.id, title: r.feature })),
      dataModel: srs && srs.dataModel.length ? srs.dataModel : prd.spec.dataEntities,
      externalInterfaces: srs ? srs.apiInterfaces.map((a) => a.target) : [],
      nfrs: prd.nfrs,
    };
    const user = prior
      ? [
          `SRS/PRD:\n${JSON.stringify(summary)}`,
          "",
          "Your previous architecture had these BLOCKING gaps — fix every one:",
          ...prior.gaps.filter(isBlocking).map((g) => `- ${g.message}`),
          "",
          "Return the corrected SAD JSON.",
        ].join("\n")
      : `SRS/PRD:\n${JSON.stringify(summary)}\n\nReturn the SAD JSON.`;

    // Inject the fleet's PLANNING-phase learned conventions (e.g. Supabase Auth, never Clerk).
    const system = ARCHITECT_SYSTEM_PROMPT + (opts.template ? architectTemplateBlock(opts.template) : "") + (await fleetBlock(undefined, "planning"));
    const { text, finishReason } = await generateTextResilient({ model: modelFactory(config), system, prompt: user, maxOutputTokens: 12000 });
    // A "length" finishReason means the model truncated mid-JSON → unparseable → empty design,
    // which reviewArchitecture flags (no-workstreams) so the loop retries. The concise prompt keeps
    // the SAD within one response.
    if (process.env.ARCH_DEBUG) console.error(`[arch] text.len=${text.length} finish=${finishReason}`);
    return coerceArchitecture(tryExtractJsonObject(text), prd, srs);
  };
}
