/**
 * The LLM summarizer — the ONLY non-deterministic step, and it touches NOTHING that
 * matters for safety. It receives a shortlist that the deterministic core has ALREADY
 * vetted and ranked, and writes a 2-4 sentence plain-English recommendation for a
 * non-technical operator. It does not re-judge safety (the evidence already did) and it
 * cannot change a disposition. Reuses the engine ModelFactory; advisory output only.
 */
import { configForStage } from "../config/models.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory , generateTextResilient} from "../engine/bolt/driver.ts";
import type { Summarizer } from "./types.ts";

const SUMMARY_SYSTEM_PROMPT = `You advise a NON-TECHNICAL founder on one make-vs-buy decision for their app. You are given a capability and a VETTED, ranked shortlist — it was already filtered for license, security advisories, and maintenance, so TRUST that vetting and do not re-evaluate safety. In 2-4 plain sentences, in everyday language (no jargon, no code, no markdown): name the recommended option and why it leads, mention the strongest alternative if there is one, and state the ONE thing the founder must personally decide (cost, data-residency, or compliance — the vetting cannot judge those). If the shortlist is empty or everything was rejected, say plainly that nothing safe was found off-the-shelf and this should be built or taken to a person.`;

export interface LlmSummarizerOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

export function llmSummarizer(opts: LlmSummarizerOptions = {}): Summarizer {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config: EngineConfig =
    opts.config ??
    configForStage("procurement");

  return async (cap, ranked) => {
    const shortlist = ranked.slice(0, 5).map((c) => ({
      name: c.candidate.name,
      kind: c.candidate.kind,
      license: c.evidence?.license ?? null,
      score: c.score,
      safe: c.safety.safe,
      blockers: c.safety.blockers,
      warnings: c.safety.warnings,
    }));
    const { text } = await generateTextResilient({
      model: modelFactory(config),
      system: SUMMARY_SYSTEM_PROMPT,
      prompt: `Capability: ${cap.key} — ${cap.need}\nVetted, ranked shortlist (best first):\n${JSON.stringify(shortlist)}`,
      maxOutputTokens: 500,
    });
    return text.trim().slice(0, 1200);
  };
}
