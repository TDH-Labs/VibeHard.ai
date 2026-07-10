/**
 * The LLM classifier — the ONLY place the orchestrator uses a model, and only to map a
 * free-form human message to a known verb (or "chat" for a conversational reply). It never
 * takes an action; the orchestrator runs deterministic code for each verb and gates the
 * consequential ones behind a human confirm. LLM proposes the intent, deterministic disposes.
 *
 * `modelFactory`/`config` are REQUIRED on `llmClassifier(opts)` (2026-07-10 extraction), not
 * optional-with-a-VibeHard-flavored-default — which model/provider to use by default is itself a
 * piece of VibeHard's own roster, not something this package should silently pick. The host
 * application (VibeHard's own `web/server.ts`) supplies both explicitly.
 * `generateTextResilient`/`tryExtractJsonObject` are duplicated rather than imported from
 * VibeHard's `engine/bolt/driver.ts`/`spec/coerce.ts` — both are small, VibeHard-logic-free, and
 * this fully severs the package's dependency on VibeHard internals (same treatment as
 * `@vibehard/gate-check`'s `functest.ts`).
 */
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import type { Classification, Classifier, Intent } from "./orchestrator.ts";

/** Minimal, package-local model-selection contract — structurally compatible with VibeHard's own
 *  `EngineConfig` ({provider, model}), so the host application's config passes through unchanged. */
export interface LlmConfig {
  provider: string;
  model: string;
}
export type ModelFactory = (config: LlmConfig) => LanguageModel;

/** Duplicated from VibeHard's `engine/bolt/driver.ts` (same reasoning there: transient-fault
 *  resilience + provider-degeneration detection, zero VibeHard-specific logic). */
async function generateTextResilient(
  args: Parameters<typeof generateText>[0],
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<Awaited<ReturnType<typeof generateText>>> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await generateText({ ...args, abortSignal: AbortSignal.timeout(timeoutMs) });
      if (!result.text.trim()) {
        lastErr = new Error("whitespace-only model response");
        if (attempt === retries) throw lastErr;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return result;
    } catch (e) {
      lastErr = e;
      const sig = e instanceof Error ? `${e.name} ${e.message}` : String(e);
      const transient = /timed out|timeout|ECONNRESET|fetch failed|network|terminated|socket|JSON parse|JSONParseError|JSON parsing failed|Invalid JSON response|Unexpected EOF|whitespace-only|\b(429|500|502|503|504)\b/i.test(sig);
      if (!transient || attempt === retries) throw e;
      console.error(`[llm-retry] attempt ${attempt + 1}/${retries + 1} failed transiently (${sig.slice(0, 120)}) — retrying`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Duplicated from VibeHard's `spec/coerce.ts` — pull the first JSON object out of LLM text
 *  (fenced, bare, or wrapped in prose). */
function tryExtractJsonObject(text: string): unknown | null {
  try {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fence ? (fence[1] ?? "") : text;
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const INTENTS: readonly Intent[] = ["status", "why", "retry", "ship", "set-model", "help", "chat"];

const SYSTEM = `You route a non-technical person's message about their in-progress app build to ONE action. Reply ONLY JSON: { "intent": one of ["status","why","retry","ship","set-model","help","chat"], "arg": optional string }.
- status: they want to know where the build is.
- why: they want to know what's wrong / why it stopped.
- retry: they want it to try again / fix and re-check.
- ship: they want to deploy/release it (a big, consequential step).
- set-model: they want to switch the AI model; put "<stage> <model>" in arg if named.
- help: they ask what they can do.
- chat: anything else / a general question — put a short, friendly reply in "arg".`;

export function coerceClassification(raw: unknown): Classification {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const intent = INTENTS.includes(o.intent as Intent) ? (o.intent as Intent) : "chat";
  const arg = typeof o.arg === "string" ? o.arg : undefined;
  return { intent, arg };
}

export function llmClassifier(opts: { modelFactory: ModelFactory; config: LlmConfig }): Classifier {
  const { modelFactory, config } = opts;
  return async (message, context) => {
    try {
      const { text } = await generateTextResilient({
        model: modelFactory(config),
        system: SYSTEM,
        prompt: `Build context: ${context}\n\nTheir message: ${message}`,
        maxOutputTokens: 4000,
        abortSignal: AbortSignal.timeout(15_000),
      });
      return coerceClassification(tryExtractJsonObject(text));
    } catch {
      return { intent: "chat", arg: "I didn't catch that — say \"status\", \"why\", \"retry\", or \"help\"." };
    }
  };
}
