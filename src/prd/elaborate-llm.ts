/**
 * The live `Elaborator` (PROJECT_BRIEF.md §22): an LLM turns a Spec into requirements
 * with acceptance criteria. `coerceRequirements` forces its JSON through the trust
 * boundary; `assemblePrd` (in elaborate.ts's loop) then derives the NFRs + buy-vs-build
 * deterministically. The model only proposes the functional requirements.
 */
import { generateText } from "ai";
import { extractJsonObject, type Spec } from "../spec/index.ts";
import { isBlocking } from "../types.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import { coerceRequirements } from "./prd.ts";
import type { Elaborator } from "./elaborate.ts";

const ELABORATE_SYSTEM_PROMPT = `You turn an app SPEC into a PRD's functional requirements. For EACH feature in the spec, produce one requirement with concrete, TESTABLE acceptance criteria (how we'd verify it's done).

Return ONLY a JSON object (no prose, no markdown fence):
{ "requirements": [ { "feature": string, "detail": string, "acceptance": string[] } ] }

Rules:
- Cover EVERY spec feature with at least one requirement (use the feature's exact text in "feature").
- "acceptance" must be specific and checkable (e.g. "a user can only see notes where user_id = their id"), not vague ("works well").
- Do NOT invent security/compliance requirements here — those are derived separately. Focus on functional behavior.
- If given previous PRD gaps, FIX every one in the new JSON.`;

export interface LlmElaboratorOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

export function llmElaborator(opts: LlmElaboratorOptions = {}): Elaborator {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config: EngineConfig =
    opts.config ??
    (process.env.OPENCODE_API_KEY ? { provider: "opencode", model: "deepseek-v4-pro" } : { provider: "anthropic", model: "claude-opus-4-8" });

  return async (spec, prior) => {
    const base = `Spec:\n${JSON.stringify({ name: spec.name, summary: spec.summary, features: spec.features, users: spec.users })}`;
    const user = prior
      ? [
          base,
          "",
          "Your previous PRD draft had these BLOCKING gaps — fix every one:",
          ...prior.gaps.filter(isBlocking).map((g) => `- ${g.message}`),
          "",
          "Return the corrected requirements JSON.",
        ].join("\n")
      : `${base}\n\nReturn the requirements JSON.`;

    const { text } = await generateText({ model: modelFactory(config), system: ELABORATE_SYSTEM_PROMPT, prompt: user, maxOutputTokens: 6000 });
    const obj = extractJsonObject(text) as { requirements?: unknown };
    return coerceRequirements(obj.requirements);
  };
}
