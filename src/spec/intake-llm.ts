/**
 * The live `Intake` (PROJECT_BRIEF.md §22): an LLM drafts a `Spec` as JSON, which
 * `parseSpec` then forces through the deterministic trust boundary (coerce.ts). The
 * model proposes the spec; our code validates its shape and `reviewSpec` judges its
 * readiness. Reuses the engine's ModelFactory so provider/model selection is the
 * single source of truth (§13). The I/O half — the loop in intake.ts stays pure.
 */
import { configForStage } from "../config/models.ts";
import { isBlocking } from "../types.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory , generateTextResilient} from "../engine/bolt/driver.ts";
import { coerceSpec, tryExtractJsonObject } from "./coerce.ts";
import type { Intake } from "./intake.ts";

const INTAKE_SYSTEM_PROMPT = `You turn a non-technical person's app idea into a structured PRD (product spec) that a builder AND an automated security gate will use. Assess the idea HONESTLY — especially the security-relevant fields, which decide what protections the build needs.

Return ONLY a JSON object (no prose, no markdown fence) with exactly these fields:
{
  "name": string,            // short kebab-case app name
  "summary": string,         // 1-2 sentences on what it is; if it stores sensitive data, state the retention/deletion plan
  "features": string[],      // concrete things the app does
  "users": string,           // who uses it, in plain words
  "tenancy": "single-user" | "single-tenant" | "multi-tenant",  // multi-tenant = multiple separate customers/teams share one deployment
  "deployTarget": "hosted-app" | "downloadable-tool",  // hosted-app = lives at a URL others reach; downloadable-tool = a CLI/script the user runs locally, no server
  "auth": string,            // "none" | "email-password" | "oauth" | "sso" | ... — how users sign in
  "storesData": boolean,     // does it persist data?
  "clientOnlyStorage": boolean,  // true ONLY if ALL persisted data lives in the browser/device itself (localStorage/IndexedDB) — no server, no database, nothing to sync or share across devices or logins
  "dataEntities": [ { "name": string, "fields": string[], "sensitive": boolean } ],  // the data model; sensitive=true for PII/PHI/financial/credentials
  "sensitiveData": ("none"|"pii"|"phi"|"financial"|"credentials")[],  // classify the data; ["none"] if none
  "realUsers": boolean,      // see the INTENT question below
  "maintained": boolean      // see the INTENT question below
}

Rules:
- Be honest about tenancy/auth/sensitiveData — understating them hides real risk.
- If multiple customers/teams share one deployment and any data is sensitive, set tenancy "multi-tenant".
- deployTarget: default "hosted-app" unless the idea is CLEARLY local-only — no server, runs on the
  user's own machine, a CLI/script/terminal tool, not accessed via a URL by anyone else. E.g. "I want to
  interact with it via a TUI" + "just me, locally" → "downloadable-tool". A client portal, a dashboard
  multiple people log into, or anything mentioning "customers"/"clients"/"my team" accessing it remotely
  → "hosted-app".
- clientOnlyStorage: true ONLY for a hosted-app that has NO account system and NO cross-device/
  cross-user sharing — e.g. "a timer/counter/notes tool that just remembers state in THIS browser."
  If two people could ever need to see the SAME data, or one person needs it on a second device, or
  there's any login/account at all, set it FALSE — that needs a real backend. When storesData is
  false, this doesn't matter (nothing persists either way).
- NEVER describe the app as "compliant" or "certified" with any standard.
- INTENT (this drives how much rigor the build gets). Read how they describe the idea and answer one question: "Is this something they're building to RELY ON and keep improving — or a quick experiment they might not keep?"
    • sounds real / ongoing / for actual use → realUsers=true AND maintained=true
    • clearly a throwaway, demo, or one-off experiment → both false
    • UNCLEAR → default BOTH to true. Under-investing in something real is worse than over-investing in a throwaway, so when in doubt, treat it as real.
  (Sensitive data always gets the careful path regardless of this answer.)
- If given previous blocking gaps, FIX them in the new JSON.`;

export interface LlmIntakeOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

/** The production intake: prompt → PRD JSON → coerced `Spec`. */
export function llmIntake(opts: LlmIntakeOptions = {}): Intake {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config: EngineConfig =
    opts.config ??
    configForStage("spec");

  return async (prompt, prior) => {
    const user = prior
      ? [
          `App idea: ${prompt}`,
          "",
          "Your previous PRD draft had these BLOCKING gaps — fix every one:",
          ...prior.gaps.filter(isBlocking).map((g) => `- ${g.message}`),
          "",
          `Previous draft:\n${JSON.stringify(prior.spec)}`,
          "",
          "Return the corrected PRD JSON.",
        ].join("\n")
      : `App idea: ${prompt}\n\nReturn the PRD JSON.`;

    const { text } = await generateTextResilient({
      model: modelFactory(config),
      system: INTAKE_SYSTEM_PROMPT,
      prompt: user,
      maxOutputTokens: 6000,
    });
    // Resilient: a malformed/empty response → a default spec, which reviewSpec flags
    // (no-features) so the grill loop retries instead of the build crashing.
    return coerceSpec(tryExtractJsonObject(text));
  };
}
