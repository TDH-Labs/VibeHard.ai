/**
 * The live `Intake` (PROJECT_BRIEF.md §22): an LLM drafts a `Prd` as JSON, which
 * `parsePrd` then forces through the deterministic trust boundary (coerce.ts). The
 * model proposes the spec; our code validates its shape and `reviewPrd` judges its
 * readiness. Reuses the engine's ModelFactory so provider/model selection is the
 * single source of truth (§13). The I/O half — the loop in intake.ts stays pure.
 */
import { generateText } from "ai";
import { isBlocking } from "../types.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import { parsePrd } from "./coerce.ts";
import type { Intake } from "./intake.ts";

const INTAKE_SYSTEM_PROMPT = `You turn a non-technical person's app idea into a structured PRD (product spec) that a builder AND an automated security gate will use. Assess the idea HONESTLY — especially the security-relevant fields, which decide what protections the build needs.

Return ONLY a JSON object (no prose, no markdown fence) with exactly these fields:
{
  "name": string,            // short kebab-case app name
  "summary": string,         // 1-2 sentences on what it is; if it stores sensitive data, state the retention/deletion plan
  "features": string[],      // concrete things the app does
  "users": string,           // who uses it, in plain words
  "tenancy": "single-user" | "single-tenant" | "multi-tenant",  // multi-tenant = multiple separate customers/teams share one deployment
  "auth": string,            // "none" | "email-password" | "oauth" | "sso" | ... — how users sign in
  "storesData": boolean,     // does it persist data?
  "dataEntities": [ { "name": string, "fields": string[], "sensitive": boolean } ],  // the data model; sensitive=true for PII/PHI/financial/credentials
  "sensitiveData": ("none"|"pii"|"phi"|"financial"|"credentials")[],  // classify the data; ["none"] if none
  "realUsers": boolean,      // for real users, not a throwaway/demo?
  "maintained": boolean      // will it live and be maintained over time?
}

Rules:
- Be honest about tenancy/auth/sensitiveData — understating them hides real risk.
- If multiple customers/teams share one deployment and any data is sensitive, set tenancy "multi-tenant".
- NEVER describe the app as "compliant" or "certified" with any standard.
- If given previous blocking gaps, FIX them in the new JSON.`;

export interface LlmIntakeOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

/** The production intake: prompt → PRD JSON → coerced `Prd`. */
export function llmIntake(opts: LlmIntakeOptions = {}): Intake {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config: EngineConfig =
    opts.config ??
    (process.env.OPENCODE_API_KEY ? { provider: "opencode", model: "deepseek-v4-pro" } : { provider: "anthropic", model: "claude-opus-4-8" });

  return async (prompt, prior) => {
    const user = prior
      ? [
          `App idea: ${prompt}`,
          "",
          "Your previous PRD draft had these BLOCKING gaps — fix every one:",
          ...prior.gaps.filter(isBlocking).map((g) => `- ${g.message}`),
          "",
          `Previous draft:\n${JSON.stringify(prior.prd)}`,
          "",
          "Return the corrected PRD JSON.",
        ].join("\n")
      : `App idea: ${prompt}\n\nReturn the PRD JSON.`;

    const { text } = await generateText({
      model: modelFactory(config),
      system: INTAKE_SYSTEM_PROMPT,
      prompt: user,
      maxOutputTokens: 4000,
    });
    return parsePrd(text);
  };
}
