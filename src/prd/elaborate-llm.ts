/**
 * The live `Elaborator` (PROJECT_BRIEF.md §22): an LLM acting as a Principal PM turns a Spec
 * into a full PRD draft — a one-pager (overview/problem/objectives/constraints), personas,
 * scenarios, scoped + prioritised features with acceptance criteria, success metrics, and
 * risks. `coercePrdDraft` forces its JSON through the trust boundary; `assemblePrd` then
 * derives the NFRs + buy-vs-build deterministically (§11 — the model never invents the
 * security posture). The deterministic `reviewPrd` decides "ready", not the model.
 */
import { generateText } from "ai";
import { tryExtractJsonObject, type Spec } from "../spec/index.ts";
import { isBlocking } from "../types.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import { coercePrdDraft } from "./prd.ts";
import type { Elaborator } from "./elaborate.ts";

const ELABORATE_SYSTEM_PROMPT = `# Role
You are an expert Principal Product Manager with deep experience scaling software products from zero to one, and one to N. You write Product Requirements Documents that engineering can build from directly.

# Task
Fill out a PRD based ONLY on the specific product described in the SPEC provided. Output a single JSON object — no prose, no markdown fence.

# Guidelines (non-negotiable)
1. ZERO BIAS — do not assume any industry, platform (iOS/Android/Web), or business model unless the spec states it. If the spec is silent, stay neutral; never invent a vertical.
2. CLARITY OVER FLUFF — be concise, specific, and metrics-driven. No generic filler ("seamless experience", "robust solution"). Every sentence must carry information specific to THIS product.
3. LOGICAL CONSISTENCY — the Problem, Objectives, Scenarios, and In-Scope Features must line up perfectly. Every in-scope feature must directly address a component of the Problem AND advance at least one Objective AND serve at least one Scenario. If a feature traces to nothing, cut it.
4. HONESTY — do not fabricate quantitative baselines you can't know (user counts, current conversion). State metric *targets* only when they follow from the spec; otherwise describe the metric without a fabricated number.

# Output schema
{
  "title": string,                          // "PRD for <product>"
  "overview": string,                       // 2-4 sentences: what it is + the core value proposition
  "problemStatement": string,               // the friction/opportunity and why it's worth solving now
  "objectives": string[],                   // 2-4 explicit, outcome-shaped goals
  "constraints": string[],                  // real bounds/dependencies (regulatory, technical, data)
  "personas": [ { "name": string, "kind": "primary"|"secondary", "description": string } ],  // behaviour + motivation; >=1 primary; derive from the spec's users
  "scenarios": [ { "id": "S1", "persona": string, "context": string, "action": string, "outcome": string } ],  // end-to-end; persona MUST match a personas[].name
  "requirements": [ { "id": "F1", "feature": string, "detail": string, "acceptance": string[], "priority": "MVP"|"P1"|"P2", "scenarioRefs": ["S1"] } ],
  "outOfScope": [ { "feature": string, "reason": string } ],
  "successMetrics": [ { "kind": "primary"|"secondary", "metric": string, "target": string } ],  // >=1 primary; omit "target" if you can't justify a number
  "risks": [ { "risk": string, "impact": "H"|"M"|"L", "mitigation": string } ],
  "openQuestions": string[]
}

# Rules
- Cover EVERY feature in the spec with at least one in-scope requirement. Put the spec feature's EXACT text in "feature" (this links coverage). Use "detail" for what it does + the user value.
- "acceptance" must be specific and checkable (e.g. "a user can only read rows where user_id = their id"), never vague ("works well").
- Every requirement's "scenarioRefs" must list >=1 existing scenario id. Every scenario's "persona" must be one of the personas you defined.
- Mark launch-blocking features "MVP"; defer the rest to "P1"/"P2" and list genuinely-excluded capabilities under outOfScope with a reason.
- Do NOT write security/compliance/non-functional requirements — those are derived separately. Focus on product: problem, users, behaviour, value, metrics.
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
    const specView = {
      name: spec.name,
      summary: spec.summary,
      features: spec.features,
      users: spec.users,
      tenancy: spec.tenancy,
      storesData: spec.storesData,
      dataEntities: spec.dataEntities,
    };
    const base = `SPEC:\n${JSON.stringify(specView, null, 2)}`;
    const blocking = prior?.gaps.filter(isBlocking) ?? [];
    const advisory = prior?.gaps.filter((g) => !isBlocking(g)) ?? [];
    const user = prior
      ? [
          base,
          "",
          "Your previous PRD draft had these BLOCKING gaps — fix every one:",
          ...blocking.map((g) => `- ${g.message}`),
          ...(advisory.length ? ["", "And improve on these (advisory):", ...advisory.map((g) => `- ${g.message}`)] : []),
          "",
          "Return the corrected PRD JSON.",
        ].join("\n")
      : `${base}\n\nReturn the PRD JSON.`;

    const { text } = await generateText({ model: modelFactory(config), system: ELABORATE_SYSTEM_PROMPT, prompt: user, maxOutputTokens: 14000 });
    // Resilient: a malformed response coerces to a near-empty draft, which reviewPrd flags so
    // the loop retries rather than crashing the build (§ degrade, never throw).
    const obj = tryExtractJsonObject(text);
    return coercePrdDraft(obj, spec);
  };
}
