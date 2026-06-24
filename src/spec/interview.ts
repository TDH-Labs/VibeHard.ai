/**
 * grill-me as a real INTERVIEW (backlog #1 / Tier-2). Instead of one batch of assumptions, the
 * builder is interviewed ONE QUESTION AT A TIME — each question branches on the previous answers
 * and ships a RECOMMENDED answer, so a non-technical user clears most turns with one tap. Modelled
 * on the brainstorming + grilling skills: serial, dependency-ordered, relentless-but-bounded,
 * challenges scope/risk, and ends on a plain-language confirmation.
 *
 * The engine exposes a single-step seam (`Interviewer`: given the request + the Q&A so far, return
 * the NEXT question or signal done) + pure helpers (coerce trust boundary, fold). The CLI and web
 * each drive the loop, so the same engine powers a terminal back-and-forth and a dashboard panel.
 * OPTIONAL + fail-safe: any error → done, so a build never blocks on the interview.
 */
import { generateText } from "ai";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import { tryExtractJsonObject } from "./coerce.ts";

/** Hard cap on questions — a non-technical user won't tolerate an unbounded interrogation. */
export const MAX_QUESTIONS = 7;

/** One asked-and-answered turn. */
export interface InterviewTurn {
  question: string;
  answer: string;
}

/** The next question to ask, with the default the user can just accept. */
export interface InterviewQuestion {
  question: string;
  recommended: string;
}

/** A single interview step: the next question, or done (no more build-changing ambiguity). */
export interface InterviewStep {
  done: boolean;
  question: InterviewQuestion | null;
}

/** Trust boundary: coerce the model's JSON into a valid step. Missing/blank question → done
 *  (fail-safe: never invent a question; just stop). */
export function coerceStep(raw: unknown): InterviewStep {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (o.done === true) return { done: true, question: null };
  const q = o.question && typeof o.question === "object" ? (o.question as Record<string, unknown>) : {};
  const question = typeof q.question === "string" ? q.question.trim() : typeof o.question === "string" ? (o.question as string).trim() : "";
  const recommended = typeof q.recommended === "string" ? q.recommended.trim() : typeof o.recommended === "string" ? (o.recommended as string).trim() : "";
  if (!question) return { done: true, question: null };
  return { done: false, question: { question, recommended } };
}

/** Pure: fold the answered turns into the build prompt as confirmed details. Blank answers dropped;
 *  none → the original prompt unchanged. */
export function foldInterview(prompt: string, turns: InterviewTurn[]): string {
  const answered = turns.filter((t) => t && typeof t.answer === "string" && t.answer.trim() && typeof t.question === "string" && t.question.trim());
  if (!answered.length) return prompt;
  return `${prompt}\n\nConfirmed details about the app:\n${answered.map((t) => `- ${t.question.trim()} → ${t.answer.trim()}`).join("\n")}`;
}

const INTERVIEW_SYSTEM_PROMPT = `You are interviewing a NON-TECHNICAL person to pin down the web app they want, BEFORE it is built. You ask ONE question at a time and you already have the conversation so far.

Decide the SINGLE most important next question — the one whose answer would most change WHAT gets built — and give a sensible RECOMMENDED answer they can just accept.

How to choose the next question (branch on what they've already said):
- Start with who uses it and who may see whose data (the costliest thing to get wrong), then key behaviours, then important edge cases.
- Do NOT ask anything already answered by the request or an earlier answer. Do NOT ask about technology, hosting, or frameworks.
- Gently CHALLENGE risky or scope-creepy choices in plain terms (e.g. "storing card numbers is a big legal burden — most apps let Stripe hold those so you never touch them; want that?").
- TRADE-OFFS ARE THE USER'S CALL, NOT YOURS: if the app takes PAYMENTS, sends EMAIL/SMS, needs SOCIAL/SSO login, or stores SENSITIVE personal data, you MUST include one question that puts the key build-vs-buy / who-holds-the-data choice to them — with your recommendation (e.g. "use Stripe so you never store card data" / "use a managed email service vs. build your own"). Never silently decide these for them.

How much to ask:
- For ANY app that has users or stores data, ask AT LEAST 3 questions before you may stop — cover, in order: (1) who can see WHOSE data, (2) the single most important behaviour the request leaves open, (3) a key edge case OR a scope/risk trade-off. Ask up to ~6 if real ambiguity remains.
- Set "done": true only once you've met that minimum AND nothing left to ask would change what gets built. For a genuinely trivial tool (no users, no stored data), you may stop immediately.
- The conversation so far tells you how many you've already asked — don't stop short of the minimum.

Each question must be ONE plain-language sentence, answerable in a few words. The recommended answer must be a concrete, sensible default.

Return ONLY JSON:
- to ask: { "done": false, "question": { "question": string, "recommended": string } }
- to stop: { "done": true }`;

export interface InterviewerOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

/** Soft minimum the caller's prompt enforces for a non-trivial app (the first question establishes
 *  non-triviality; once asked, don't stop before this many). */
const MIN_QUESTIONS = 3;

function renderHistory(prompt: string, history: InterviewTurn[]): string {
  const lines = [`App request: ${prompt}`, ``];
  if (history.length) {
    lines.push(`Conversation so far (${history.length} question(s) asked):`);
    for (const t of history) lines.push(`Q: ${t.question}\nA: ${t.answer}`);
    if (history.length < MIN_QUESTIONS) {
      // The first question already established this app is non-trivial → hold to the minimum.
      lines.push(``, `You have asked ${history.length} question(s). Do NOT stop yet — ask at least ${MIN_QUESTIONS} in total. Pick the next most useful question.`);
    }
  } else {
    lines.push(`No questions asked yet — choose the first (or, for a genuinely trivial tool with no users and no stored data, you may stop immediately).`);
  }
  lines.push(``, `Now give the next step (a question, or done).`);
  return lines.join("\n");
}

/** The live interviewer — one model call per question. */
export function llmInterviewer(opts: InterviewerOptions = {}): Interviewer {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const provider = process.env.VIBEHARD_PROVIDER || (process.env.OPENCODE_API_KEY ? "opencode" : "anthropic");
  // The interview is user-facing and short — default to the CAPABLE model (not the fast build model)
  // for reliable, well-branched questions. Override with VIBEHARD_INTAKE_MODEL.
  const model = process.env.VIBEHARD_INTAKE_MODEL || (provider === "opencode" ? "deepseek-v4-pro" : "claude-opus-4-8");
  const config: EngineConfig = opts.config ?? { provider, model };
  return async (prompt: string, history: InterviewTurn[]) => {
    try {
      const { text } = await generateText({ model: modelFactory(config), system: INTERVIEW_SYSTEM_PROMPT, prompt: renderHistory(prompt, history), maxOutputTokens: 4000, abortSignal: AbortSignal.timeout(20_000) });
      return coerceStep(tryExtractJsonObject(text));
    } catch {
      return { done: true, question: null }; // fail-safe: any error ends the interview, build proceeds
    }
  };
}

/** Given the request + the Q&A so far, return the next question or signal done. */
export type Interviewer = (prompt: string, history: InterviewTurn[]) => Promise<InterviewStep>;
