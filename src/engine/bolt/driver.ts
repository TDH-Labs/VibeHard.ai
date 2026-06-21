/**
 * Live BoltDriver — the real generation engine behind the seam (PROJECT_BRIEF.md
 * §13). Calls an LLM via the Vercel AI SDK with the derived bolt system prompt and
 * streams the model's native bolt-protocol text out as raw chunks. Everything
 * above the seam (normalizer → materialization → gate → escalation) is unchanged.
 *
 * Provider routing stays OURS: the model is built from EngineConfig (provider +
 * model passed in). Secrets come from the host environment, never from EngineConfig
 * (§13). The model factory is injectable so tests run against a mock LLM (no
 * network, no key) — same discipline as mocking the gates' container boundary.
 */
import { streamText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EngineConfig } from "../../types.ts";
import type { BoltDriver } from "./engine.ts";
import { DRYDOCK_SYSTEM_PROMPT } from "./prompt.ts";

/** Build the AI-SDK model for an EngineConfig. The one place provider specifics live. */
export type ModelFactory = (config: EngineConfig) => LanguageModel;

/** Whole apps stream as a single artifact — give the model room (skill default for streaming). */
const MAX_OUTPUT_TOKENS = 64_000;

/** Default factory: maps EngineConfig.provider → an AI-SDK model, secrets from env. */
export const defaultModelFactory: ModelFactory = (config) => {
  switch (config.provider) {
    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY is not set — required for live generation");
      }
      return createAnthropic({ apiKey })(config.model);
    }
    case "opencode": {
      // opencode-go: an OpenAI-compatible gateway. Provider routing + base URL stay
      // OURS (config/env); secret from env, never carried in EngineConfig (§13).
      const apiKey = process.env.OPENCODE_API_KEY;
      if (!apiKey) {
        throw new Error("OPENCODE_API_KEY is not set — required for live generation via opencode");
      }
      return createOpenAICompatible({
        name: "opencode",
        baseURL: process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1",
        apiKey,
      })(config.model);
    }
    default:
      // Adding a provider is a one-case change here — the seam above never moves (§13).
      throw new Error(`unsupported engine provider '${config.provider}' (add an adapter in driver.ts)`);
  }
};

export interface LiveBoltDriverOptions {
  /** Override model construction (tests inject a mock LLM). */
  modelFactory?: ModelFactory;
}

/**
 * The production driver. `run()` streams the LLM's bolt-protocol output chunk by
 * chunk; BoltSession accumulates, parses, materializes, and gates it.
 */
export function liveBoltDriver(opts: LiveBoltDriverOptions = {}): BoltDriver {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  return {
    name: "bolt.diy",
    async *run(prompt: string, config: EngineConfig): AsyncIterable<string> {
      const result = streamText({
        model: modelFactory(config),
        system: DRYDOCK_SYSTEM_PROMPT,
        prompt,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      for await (const chunk of result.textStream) yield chunk;
    },
  };
}
