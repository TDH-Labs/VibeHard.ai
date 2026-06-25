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
import { generateText, streamText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EngineConfig } from "../../types.ts";
import type { BoltDriver } from "./engine.ts";
import { VIBEHARD_SYSTEM_PROMPT } from "./prompt.ts";

/**
 * `generateText` with a generous EXPLICIT timeout + retry-on-transient. The planning stages
 * (PRD/SRS/architecture) generate large outputs (12–16k tokens) on a reasoning model, and a
 * single slow/dropped request was throwing an uncaught `TimeoutError` that PANICKED the whole
 * build — losing all prior planning. A transient LLM hiccup must never crash an autonomous run:
 * here we bound each attempt and retry transient failures (timeout/network/429/5xx) with backoff.
 */
export async function generateTextResilient(
  args: Parameters<typeof generateText>[0],
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<Awaited<ReturnType<typeof generateText>>> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 240_000; // 4 min — a big reasoning generation can be slow
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await generateText({ ...args, abortSignal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = e;
      const sig = e instanceof Error ? `${e.name} ${e.message}` : String(e);
      const transient = /timed out|timeout|ECONNRESET|fetch failed|network|terminated|socket|\b(429|500|502|503|504)\b/i.test(sig);
      if (!transient || attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); // linear backoff
    }
  }
  throw lastErr;
}

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

/**
 * BYO-key factory: builds the model from EXPLICIT credentials (a tenant's own key) instead of the
 * host env, so a customer's builds run on their account — not the operator's. Same provider mapping
 * as defaultModelFactory; the key is supplied at construction and never stored in EngineConfig (§13).
 * The web layer reads the tenant's encrypted key, calls this, and passes the factory into the build.
 */
export function byoModelFactory(creds: { anthropicKey?: string; openaiKey?: string; openaiBaseURL?: string }): ModelFactory {
  return (config) => {
    switch (config.provider) {
      case "anthropic": {
        if (!creds.anthropicKey) throw new Error("byoModelFactory: this tenant has no Anthropic key on file");
        return createAnthropic({ apiKey: creds.anthropicKey })(config.model);
      }
      case "opencode": {
        if (!creds.openaiKey) throw new Error("byoModelFactory: this tenant has no OpenAI-compatible key on file");
        return createOpenAICompatible({ name: "byo", baseURL: creds.openaiBaseURL ?? "https://opencode.ai/zen/go/v1", apiKey: creds.openaiKey })(config.model);
      }
      default:
        throw new Error(`byoModelFactory: unsupported provider '${config.provider}'`);
    }
  };
}

export interface LiveBoltDriverOptions {
  /** Override model construction (tests inject a mock LLM). */
  modelFactory?: ModelFactory;
  /** The codegen system prompt (defaults to the TypeScript/Supabase one). Set this to
   *  PYTHON_SYSTEM_PROMPT for a Python target — see selectSystemPrompt(stack). */
  systemPrompt?: string;
}

/**
 * The production driver. `run()` streams the LLM's bolt-protocol output chunk by
 * chunk; BoltSession accumulates, parses, materializes, and gates it.
 */
export function liveBoltDriver(opts: LiveBoltDriverOptions = {}): BoltDriver {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const systemPrompt = opts.systemPrompt ?? VIBEHARD_SYSTEM_PROMPT;
  return {
    name: "bolt.diy",
    async *run(prompt: string, config: EngineConfig): AsyncIterable<string> {
      const result = streamText({
        model: modelFactory(config),
        system: systemPrompt,
        prompt,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      for await (const chunk of result.textStream) yield chunk;
    },
  };
}
