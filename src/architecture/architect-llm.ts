/**
 * The live `Architect` (PROJECT_BRIEF.md §22): an LLM designs the stack + workstream
 * dependency graph from a PRD. `coerceArchitecture` forces its JSON through the trust
 * boundary; `reviewArchitecture` (in the loop) validates the graph. The model proposes
 * the design; the deterministic checks + topological build order are ours.
 */
import { generateText } from "ai";
import { tryExtractJsonObject } from "../spec/index.ts";
import { isBlocking } from "../types.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import type { Prd } from "../prd/index.ts";
import { coerceArchitecture } from "./architecture.ts";
import type { Architect } from "./architect.ts";

const ARCHITECT_SYSTEM_PROMPT = `You design the technical architecture for an app from its PRD: the stack and the WORKSTREAMS (components), each owning a set of files, with a dependency graph between them.

Return ONLY a JSON object (no prose, no fence):
{ "stack": string, "workstreams": [ { "name": string, "responsibility": string, "files": string[], "dependsOn": string[] } ] }

Rules:
- The dependency graph MUST be acyclic. Typical order: data/schema → server/api → ui. Put each workstream's prerequisites in "dependsOn" (by name).
- Every workstream MUST own at least one file in "files".
- "dependsOn" may only name other workstreams in the list.
- Cover the PRD's requirements and data model with workstreams. If the PRD's NFRs require RLS, the data/schema workstream owns the migration with the policies.
- DEPLOYMENT CONSTRAINT (hard): if the app stores data, the data layer MUST be Supabase (Postgres + Row-Level Security) — it's the security boundary the platform verifies live before deploy. Do NOT choose MongoDB, Firebase, MySQL, DynamoDB, PlanetScale, or a self-managed Postgres (pg/Prisma/TypeORM/Knex/Drizzle against your own database). The app must deploy as EITHER a Vercel app (Next.js / Vite / static) OR a single Dockerfile container (e.g. FastAPI on Fly) — nothing that needs other managed infrastructure.
- If given previous gaps, FIX every one (e.g. break a cycle, add files, remove an unknown dependency, or move the data layer to Supabase).`;

export interface LlmArchitectOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

export function llmArchitect(opts: LlmArchitectOptions = {}): Architect {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config: EngineConfig =
    opts.config ??
    (process.env.OPENCODE_API_KEY ? { provider: "opencode", model: "deepseek-v4-pro" } : { provider: "anthropic", model: "claude-opus-4-8" });

  return async (prd, prior, srs) => {
    const summary = {
      name: prd.spec.name,
      stack_hint: { tenancy: prd.spec.tenancy, auth: prd.spec.auth, storesData: prd.spec.storesData },
      requirements: prd.requirements.map((r) => r.feature),
      // Prefer the SRS's drafted data model + interfaces when the SRS stage ran (richer than the spec).
      dataModel: srs && srs.dataModel.length ? srs.dataModel : prd.spec.dataEntities,
      nfrs: prd.nfrs,
      ...(srs ? { externalInterfaces: srs.apiInterfaces.map((a) => a.target), modules: srs.modules } : {}),
    };
    const user = prior
      ? [
          `PRD:\n${JSON.stringify(summary)}`,
          "",
          "Your previous architecture had these BLOCKING gaps — fix every one:",
          ...prior.gaps.filter(isBlocking).map((g) => `- ${g.message}`),
          "",
          "Return the corrected architecture JSON.",
        ].join("\n")
      : `PRD:\n${JSON.stringify(summary)}\n\nReturn the architecture JSON.`;

    const { text } = await generateText({ model: modelFactory(config), system: ARCHITECT_SYSTEM_PROMPT, prompt: user, maxOutputTokens: 8000 });
    // Resilient: a malformed/empty response → empty workstreams, which
    // reviewArchitecture flags (no-workstreams) so the loop retries, never crashes.
    return coerceArchitecture(tryExtractJsonObject(text), prd);
  };
}
