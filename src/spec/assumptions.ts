/**
 * grill-me, redesigned as CONFIRM-ASSUMPTIONS (backlog #1, docs/specs/grill-me.md). Instead of the
 * LLM deciding "should I ask questions?" (a borderline-prompt coin-flip), it STATES the key
 * assumptions it's about to build on — who the users are, who can see whose data, what's stored,
 * key behaviours — as plain statements the non-technical user confirms or corrects. Listing what
 * you're assuming is not a yes/no judgment, so a non-trivial app reliably yields assumptions;
 * only a genuinely trivial tool yields none. Corrections fold into the build prompt.
 *
 * Same discipline as before: injectable seam (fake-testable), coerceAssumptions is the trust
 * boundary, foldAssumptions is pure, assumptions are OPTIONAL (a bad response → the build proceeds).
 */
import { generateText } from "ai";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import { tryExtractJsonObject } from "./coerce.ts";

/** Proposes the assumptions a build will make for a prompt (injectable for tests). */
export type AssumptionProposer = (prompt: string) => Promise<string[]>;

/** One assumption the user reviewed: `text` is the final wording (their correction, or the
 *  original if they confirmed it unchanged). */
export interface ConfirmedAssumption {
  text: string;
}

/** Trust boundary: coerce the model's JSON into ≤6 non-empty, de-duplicated assumption strings. */
export function coerceAssumptions(raw: unknown): string[] {
  const obj = raw && typeof raw === "object" ? (raw as { assumptions?: unknown }) : {};
  const arr = Array.isArray(obj.assumptions) ? obj.assumptions : Array.isArray(raw) ? (raw as unknown[]) : [];
  const out: string[] = [];
  for (const a of arr) {
    if (typeof a !== "string") continue;
    const t = a.trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}

/** Pure: fold the user's confirmed/corrected assumptions into the build prompt. Blank entries are
 *  dropped; none → the original prompt unchanged. */
export function foldAssumptions(prompt: string, confirmed: ConfirmedAssumption[]): string {
  const kept = confirmed.filter((a) => a && typeof a.text === "string" && a.text.trim());
  if (!kept.length) return prompt;
  return `${prompt}\n\nConfirmed details about the app:\n${kept.map((a) => `- ${a.text.trim()}`).join("\n")}`;
}

const ASSUMPTIONS_SYSTEM_PROMPT = `You are about to build a web app for a NON-TECHNICAL person from a short request. Before building, STATE the key assumptions you're making that they might want to correct — so they review concrete statements about THEIR app instead of being interrogated.

Cover (only what applies): who the users are, WHO can see WHOSE data, what information is stored, and any important behaviour the request leaves open. Each assumption is a single plain-language statement they can confirm or change.

Rules:
- List 0 assumptions ONLY for a genuinely trivial tool with NO users and NO stored data (e.g. a unit converter). For ANY app that has users or stores data, list 2 to 5 — such a request is never fully pinned down, and getting WHO-SEES-WHOSE-DATA wrong is the costliest mistake, so include it.
- State each as a concrete DEFAULT you'd build (e.g. "Each therapist can see only their own clients' notes, not the whole practice's."), not a question.
- Plain language, no jargon. Do NOT mention technology, hosting, or frameworks.
Return ONLY a JSON object: { "assumptions": string[] }`;

export interface AssumptionProposerOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

/** The live proposer — uses the build's provider/model (or DRYDOCK_INTAKE_MODEL). */
export function llmAssumptionProposer(opts: AssumptionProposerOptions = {}): AssumptionProposer {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const provider = process.env.DRYDOCK_PROVIDER || (process.env.OPENCODE_API_KEY ? "opencode" : "anthropic");
  const model = process.env.DRYDOCK_INTAKE_MODEL || process.env.DRYDOCK_MODEL || (provider === "opencode" ? "deepseek-v4-pro" : "claude-opus-4-8");
  const config: EngineConfig = opts.config ?? { provider, model };
  return async (prompt: string) => {
    try {
      // 4000: reasoning models spend output tokens on hidden reasoning first — too small a budget
      // is fully consumed and returns empty. Assumptions are OPTIONAL, so any error → [] → build proceeds.
      const { text } = await generateText({ model: modelFactory(config), system: ASSUMPTIONS_SYSTEM_PROMPT, prompt, maxOutputTokens: 4000, abortSignal: AbortSignal.timeout(20_000) });
      return coerceAssumptions(tryExtractJsonObject(text));
    } catch {
      return [];
    }
  };
}
