/**
 * grill-me: interactive adaptive intake (backlog #1, docs/specs/grill-me.md). Before codegen, an
 * LLM proposes the FEW clarifying questions a builder needs from a non-technical prompt; the user
 * answers (or skips); the answers are folded into the prompt so the spec is sharper and fewer apps
 * get built wrong or held. Seam is injectable (fake-testable); coerceQuestions is the trust
 * boundary; foldClarifications is pure. §11: the LLM proposes the questions, the deterministic
 * coercion disposes (≤5, non-empty), and the questions are OPTIONAL — a bad response just means
 * the build proceeds without them.
 */
import { generateText } from "ai";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import { tryExtractJsonObject } from "./coerce.ts";

/** A questioner proposes clarifying questions for a prompt (injectable for tests). */
export type Questioner = (prompt: string) => Promise<string[]>;

/** One answered (or skipped) clarifying question. */
export interface Clarification {
  q: string;
  a: string;
}

/** Trust boundary: coerce the model's JSON into ≤5 non-empty, de-duplicated question strings. */
export function coerceQuestions(raw: unknown): string[] {
  const obj = raw && typeof raw === "object" ? (raw as { questions?: unknown }) : {};
  const arr = Array.isArray(obj.questions) ? obj.questions : Array.isArray(raw) ? (raw as unknown[]) : [];
  const out: string[] = [];
  for (const q of arr) {
    if (typeof q !== "string") continue;
    const t = q.trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

/** Pure: fold the user's answers into the build prompt. Blank answers are dropped; no answers →
 *  the original prompt unchanged. */
export function foldClarifications(prompt: string, answers: Clarification[]): string {
  const answered = answers.filter((x) => x && typeof x.q === "string" && typeof x.a === "string" && x.q.trim() && x.a.trim());
  if (!answered.length) return prompt;
  return `${prompt}\n\nClarifications from the user:\n${answered.map((x) => `- ${x.q.trim()} → ${x.a.trim()}`).join("\n")}`;
}

const QUESTIONS_SYSTEM_PROMPT = `You help a NON-TECHNICAL person build a web app. Given their request, ask the FEW clarifying questions a builder genuinely needs answered to build the RIGHT thing — about scope, key behaviours, who the users are, what data is involved, and important edge cases.

Rules:
- 0 to 5 questions. Ask FEWER (or NONE) only when the request is genuinely trivial (e.g. a unit converter) or already fully specified.
- When the app involves more than one kind of user, or stores records about people (clients, patients, customers), ask at least one question about WHO can see WHOSE data — unless the request already makes that explicit. Getting access wrong is the costliest mistake here.
- Each question must be SPECIFIC to THIS app and answerable in one sentence — never generic like "what features do you want?".
- Do NOT ask about anything the request already answers. Do NOT ask about technology, hosting, or frameworks (we handle that).
- Plain language, no jargon.
Return ONLY a JSON object: { "questions": string[] }`;

export interface LlmQuestionerOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

/** The live questioner — uses the same provider/model the build uses (DRYDOCK_PROVIDER/MODEL). */
export function llmQuestioner(opts: LlmQuestionerOptions = {}): Questioner {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const provider = process.env.DRYDOCK_PROVIDER || (process.env.OPENCODE_API_KEY ? "opencode" : "anthropic");
  const model = process.env.DRYDOCK_MODEL || (provider === "opencode" ? "deepseek-v4-pro" : "claude-opus-4-8");
  const config: EngineConfig = opts.config ?? { provider, model };
  return async (prompt: string) => {
    try {
      // Bounded (20s): questions are OPTIONAL — a slow/stalled provider must never block the build.
      // 4000, not 1000: reasoning models (e.g. deepseek-v4-flash) spend output tokens on hidden
      // reasoning first — too small a budget is fully consumed by reasoning and returns EMPTY text.
      const { text } = await generateText({ model: modelFactory(config), system: QUESTIONS_SYSTEM_PROMPT, prompt, maxOutputTokens: 4000, abortSignal: AbortSignal.timeout(20_000) });
      return coerceQuestions(tryExtractJsonObject(text));
    } catch {
      return []; // timeout or provider error → no questions; the build proceeds
    }
  };
}
