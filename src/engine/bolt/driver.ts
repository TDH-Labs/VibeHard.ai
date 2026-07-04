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
      const result = await generateText({ ...args, abortSignal: AbortSignal.timeout(timeoutMs) });
      // A 200 whose text is pure whitespace is provider degeneration (observed live 2026-07-04:
      // OpenRouter returned a body of newlines mid-PRD and the build died). Retry it like any
      // other transient fault instead of handing garbage to the trust boundary.
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
      // JSONParseError/Unexpected EOF: the PROVIDER's own response body failed to parse — same
      // degeneration class as above, surfaced by the SDK before we ever see text.
      const transient = /timed out|timeout|ECONNRESET|fetch failed|network|terminated|socket|JSON parse|JSONParseError|JSON parsing failed|Unexpected EOF|whitespace-only|\b(429|500|502|503|504)\b/i.test(sig);
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
    case "openrouter": {
      // OpenRouter: same OpenAI-compatible shape, vendor-prefixed model slugs (config/models.ts).
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY is not set — required for live generation via openrouter");
      }
      return createOpenAICompatible({
        name: "openrouter",
        baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
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
      case "opencode":
      case "openrouter": {
        if (!creds.openaiKey) throw new Error("byoModelFactory: this tenant has no OpenAI-compatible key on file");
        // An OpenRouter key (sk-or-…) must hit OpenRouter's endpoint regardless of which gateway
        // the PLATFORM runs on — a tenant's key knows its own home.
        const inferred = creds.openaiKey.startsWith("sk-or-") ? "https://openrouter.ai/api/v1" : "https://opencode.ai/zen/go/v1";
        return createOpenAICompatible({ name: "byo", baseURL: creds.openaiBaseURL ?? inferred, apiKey: creds.openaiKey })(config.model);
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
    // The streaming analog of generateTextResilient: a raw streamText has no timeout, so a
    // stalled stream (TCP open, no bytes) hangs the whole fix loop forever — observed live: a
    // 7-feature fix attempt sat 12 min on one dead stream. We guard with an IDLE watchdog (no
    // token for N ms ⇒ the stream is dead, abort) and an OVERALL cap, then retry-on-transient.
    // Retry-from-scratch is safe because the engine accumulates the FULL stream before
    // materializing anything (engine.ts "accumulate-then-parse") — a failed attempt writes no
    // files, so we buffer internally and yield once on success (one yield ⇒ clean restart).
    async *run(prompt: string, config: EngineConfig): AsyncIterable<string> {
      const idleMs = Number(process.env.VIBEHARD_STREAM_IDLE_MS) || 120_000; // no token for 2 min ONCE FLOWING ⇒ dead
      const ttftMs = Number(process.env.VIBEHARD_STREAM_TTFT_MS) || 300_000; // first-token grace: a reasoning model thinks before it emits (5 min)
      const overallMs = Number(process.env.VIBEHARD_STREAM_OVERALL_MS) || 900_000; // 15 min hard cap
      const retries = Number(process.env.VIBEHARD_STREAM_RETRIES ?? 2); // retry-on-transient count
      const backoffMs = Number(process.env.VIBEHARD_STREAM_BACKOFF_MS ?? 2000); // linear backoff base
      let lastErr: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        let idle: ReturnType<typeof setTimeout> | undefined;
        let flowing = false; // seen ANY stream part yet? reasoning counts — the first part is what TTFT covers
        const armIdle = () => {
          if (idle) clearTimeout(idle);
          const ms = flowing ? idleMs : ttftMs; // longer grace before the FIRST token, tighter idle between tokens
          idle = setTimeout(() => controller.abort(new Error(`stream idle ${ms}ms (no token received)`)), ms);
        };
        const overall = setTimeout(() => controller.abort(new Error(`stream exceeded ${overallMs}ms overall`)), overallMs);
        let raw: string | null = null;
        try {
          armIdle();
          // streamText does NOT reject on a provider error — it ends the stream silently and reports
          // via onError. Capture it so a failed call becomes a throw (→ retry), instead of a silent
          // empty "success" that would ship an app with no files.
          let streamErr: unknown;
          const result = streamText({ model: modelFactory(config), system: systemPrompt, prompt, maxOutputTokens: MAX_OUTPUT_TOKENS, abortSignal: controller.signal, onError: ({ error }) => { streamErr = error; } });
          let acc = "";
          // Iterate the FULL stream, not just textStream: a reasoning model emits reasoning tokens —
          // often for minutes — BEFORE its first text token. textStream yields nothing during that
          // phase, so the old watchdog aborted a healthy "thinking" stream (kimi codegen, 2/2 stalls).
          // ANY part resets the watchdog; only text deltas accumulate into the materialized output.
          for await (const part of result.fullStream) {
            flowing = true;
            armIdle();
            if (part.type === "text-delta") acc += part.text;
            else if (part.type === "error") throw part.error;
          }
          if (streamErr) throw streamErr;
          raw = acc;
        } catch (e) {
          lastErr = e;
          const sig = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          const transient = /abort|timed out|timeout|ECONNRESET|fetch failed|network|terminated|socket|idle|stream exceeded|\b(429|500|502|503|504)\b/i.test(sig);
          if (!transient || attempt === retries) throw e;
          await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1))); // linear backoff, then retry from scratch
          continue;
        } finally {
          if (idle) clearTimeout(idle);
          clearTimeout(overall);
        }
        yield raw; // outside the try: a downstream consumer error must NOT be mistaken for a stream fault
        return;
      }
      throw lastErr;
    },
  };
}
