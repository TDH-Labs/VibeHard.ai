/**
 * The LLM translator — the bounded fallback for findings the curated dictionary can't place
 * (translate.ts §"generic"). It only INTERPRETS an already-final finding into plain English;
 * it never changes severity or gates anything (§11: the LLM proposes wording, deterministic
 * code still decides pass/block). Same shape as orchestrator-llm.ts's classifier.
 */
import { configForStage } from "../config/models.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, generateTextResilient, type ModelFactory } from "../engine/bolt/driver.ts";
import { tryExtractJsonObject } from "../spec/coerce.ts";
import type { Finding } from "../types.ts";
import type { Explanation, Translator } from "./translate.ts";

const SYSTEM = `You explain a security/quality scanner finding to a non-technical small-business owner who cannot read code. Reply ONLY JSON: { "title": "a short, consequence-framed headline (under 12 words)", "detail": "1-3 plain sentences: what was found, why it matters to THEM, and the fix direction" }.
Never use jargon (no "XSS", "RLS", "sanitize", "injection" without explaining it in plain terms). Never invent specifics not implied by the finding. If genuinely unclear, say so plainly rather than guessing.`;

/** An LLM-backed Translator for translateFindings' generic-only fallback slot. */
export function llmTranslator(opts: { modelFactory?: ModelFactory; config?: EngineConfig } = {}): Translator {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config = opts.config ?? configForStage("functest"); // a light model is plenty for wording
  return async (f: Finding): Promise<Explanation> => {
    try {
      const { text } = await generateTextResilient({
        model: modelFactory(config),
        system: SYSTEM,
        prompt: `tool: ${f.tool}\nruleId: ${f.ruleId}\nseverity: ${f.severity}\nfile: ${f.file}\nmessage: ${f.message}`,
        maxOutputTokens: 4000,
        abortSignal: AbortSignal.timeout(15_000),
      });
      const parsed = tryExtractJsonObject(text) as { title?: unknown; detail?: unknown } | null;
      if (parsed && typeof parsed.title === "string" && typeof parsed.detail === "string") {
        return { ruleId: f.ruleId, title: parsed.title, detail: parsed.detail, source: "llm" };
      }
    } catch {
      // fall through to the honest generic explanation below
    }
    return {
      ruleId: f.ruleId,
      title: "A potential issue was found that needs a closer look",
      detail: `Our ${f.tool} check flagged a ${f.severity} issue (${f.ruleId}). We couldn't auto-translate this one into plain terms — a reviewer can confirm what it means and what to do.`,
      source: "generic",
    };
  };
}
