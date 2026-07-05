/**
 * Steering suggestions (EPIC #54 phase 3): propose candidate business rules from what the
 * customer already told us — the build prompt, which carries the folded grill-me interview
 * ("Confirmed details about the app: …"). The LLM only PROPOSES; every candidate then passes
 * the same deterministic normalizeSteering filter the save path uses, and nothing is applied
 * until the customer explicitly saves. Proposing is a seam, disposing stays deterministic.
 */
import { generateTextResilient, defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import type { EngineConfig } from "../types.ts";
import { configForStage } from "../config/models.ts";
import { tryExtractJsonObject } from "../spec/coerce.ts";
import { normalizeSteering } from "./steering.ts";

const SUGGEST_SYSTEM_PROMPT = `You extract a customer's STANDING business conventions from an app request.

A standing convention is a vocabulary, naming, tone, or presentation preference that would apply to
EVERY app this customer builds — not a feature of this one app. Examples: "clients are called members",
"invoices are net-30", "prices are shown in CAD", "the tone is warm and informal".

NOT conventions: features ("has a waitlist"), one-app specifics ("the app is called PawList"), anything
about security, logins, permissions, or data protection (never suggest those).

Reply with ONLY a JSON object: {"rules": ["...", "..."]} — at most 5 rules, each under 100 characters,
each phrased as a standing preference. If the request reveals no standing conventions, reply {"rules": []}.`;

export interface SuggestOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
  /** test seam: one model call (system, prompt) → raw text. Defaults to the live model. */
  generate?: (system: string, prompt: string) => Promise<string>;
}

/** Propose ≤5 candidate steering rules from a build prompt. Every candidate is re-filtered
 *  through normalizeSteering (the SAME deterministic gate the save path applies), so a
 *  security-touching or injection-flavored proposal can never surface. Returns [] on any
 *  model failure — suggestions are a convenience, never load-bearing. */
export async function suggestSteering(buildPrompt: string, existingRules: string, opts: SuggestOptions = {}): Promise<string[]> {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config: EngineConfig = opts.config ?? configForStage("intake");
  const generate =
    opts.generate ??
    (async (system: string, prompt: string) => {
      const { text } = await generateTextResilient({ model: modelFactory(config), system, prompt, maxOutputTokens: 4000 }, { timeoutMs: 45_000 });
      return text;
    });
  let raw: unknown;
  try {
    raw = tryExtractJsonObject(await generate(SUGGEST_SYSTEM_PROMPT, `App request:\n${buildPrompt.slice(0, 8000)}`));
  } catch {
    return [];
  }
  const rules = (raw as { rules?: unknown })?.rules;
  if (!Array.isArray(rules)) return [];
  const candidates = rules.filter((r): r is string => typeof r === "string").slice(0, 5);
  // Deterministic dispose: the same filter as save — plus dedupe against what's already saved.
  const existing = new Set(normalizeSteering(existingRules).kept.map((r) => r.toLowerCase()));
  return normalizeSteering(candidates.join("\n")).kept.filter((r) => !existing.has(r.toLowerCase()));
}
