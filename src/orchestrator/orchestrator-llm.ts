/**
 * The LLM classifier — the ONLY place the orchestrator uses a model, and only to map a
 * free-form human message to a known verb (or "chat" for a conversational reply). It never
 * takes an action; the orchestrator runs deterministic code for each verb and gates the
 * consequential ones behind a human confirm. LLM proposes the intent, deterministic disposes.
 */
import { generateText } from "ai";
import { configForStage } from "../config/models.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import { tryExtractJsonObject } from "../spec/coerce.ts";
import type { Classification, Classifier, Intent } from "./orchestrator.ts";

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

export function llmClassifier(opts: { modelFactory?: ModelFactory; config?: EngineConfig } = {}): Classifier {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config = opts.config ?? configForStage("functest"); // a light model is plenty for routing
  return async (message, context) => {
    try {
      const { text } = await generateText({
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
