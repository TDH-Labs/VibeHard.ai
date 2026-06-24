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
import { generateText } from "ai";
import { tryExtractJsonObject } from "../spec/index.ts";
import { isBlocking } from "../types.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import type { Prd } from "../prd/index.ts";
import type { Srs } from "../srs/index.ts";
import { coerceArchitecture } from "./architecture.ts";
import type { Architect } from "./architect.ts";

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
  "workstreams": [ { "name": string, "responsibility": string, "files": [string], "dependsOn": [string], "covers": ["FR-1"] } ]
}

# Rules
- TRACEABILITY (§6): every SRS functional requirement id (FR-1, FR-2…) MUST appear in the "covers" of at least one workstream. A single component may cover several FRs.
- The workstream dependency graph MUST be acyclic (typical order: data/schema → server/api → ui). Every workstream owns >=1 file. "dependsOn" may only name other workstreams in the list.
- DEPLOYMENT CONSTRAINT (hard): the data layer MUST be Supabase (Postgres + Row-Level Security) — the security boundary the platform verifies live before deploy. Do NOT use MongoDB, Firebase, MySQL, DynamoDB, PlanetScale, SQLite, or a self-managed Postgres (pg/Prisma/TypeORM/Knex/Drizzle). Deploy as EITHER a Vercel app (Next.js / Vite / static) OR a single Dockerfile container (e.g. FastAPI on Fly).
- §2 pattern: give the rationale (from the SRS constraints) AND state the trade-offs explicitly. §4 dataArchitecture.schema: a concise SQL DDL for the core entities (derive from the SRS data model; include the RLS-relevant owner columns).
- BE CONCISE so the whole JSON fits in one response: short phrases, a focused DDL, 3-7 workstreams. A truncated document is a failed document.
- If given previous gaps, FIX every one (break a cycle, add files or covers, move the data layer to Supabase, supply the missing pattern rationale, …).`;

export interface LlmArchitectOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

export function llmArchitect(opts: LlmArchitectOptions = {}): Architect {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config: EngineConfig =
    opts.config ??
    (process.env.OPENCODE_API_KEY ? { provider: "opencode", model: "deepseek-v4-pro" } : { provider: "anthropic", model: "claude-opus-4-8" });

  return async (prd: Prd, prior, srs?: Srs) => {
    const summary = {
      name: prd.spec.name,
      stack_hint: { tenancy: prd.spec.tenancy, auth: prd.spec.auth, storesData: prd.spec.storesData },
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

    const { text, finishReason } = await generateText({ model: modelFactory(config), system: ARCHITECT_SYSTEM_PROMPT, prompt: user, maxOutputTokens: 12000 });
    // A "length" finishReason means the model truncated mid-JSON → unparseable → empty design,
    // which reviewArchitecture flags (no-workstreams) so the loop retries. The concise prompt keeps
    // the SAD within one response.
    if (process.env.ARCH_DEBUG) console.error(`[arch] text.len=${text.length} finish=${finishReason}`);
    return coerceArchitecture(tryExtractJsonObject(text), prd, srs);
  };
}
