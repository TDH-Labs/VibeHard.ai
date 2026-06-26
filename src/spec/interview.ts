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
import { configForStage } from "../config/models.ts";
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

/** One tappable choice for a question — a short label + a one-line scope description. */
export interface InterviewOption {
  label: string;
  detail: string;
}

/** The next question to ask. Presented as MULTIPLE-CHOICE (tap an option) with a RECOMMENDED default,
 *  plus an always-available "write your own" — the non-overwhelming intake UX (modelled on Lovable's
 *  Plan-mode interview). `options` may be empty for a genuinely open question, but prefer 2–4. */
export interface InterviewQuestion {
  question: string;
  options: InterviewOption[];
  recommended: string; // the recommended option's label (or a free-text default when no options)
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
  // Coerce options: array of {label, detail}, trimmed, deduped by label, capped (a non-technical
  // user shouldn't face a wall of choices). Tolerates a bare string[] too.
  const rawOpts = Array.isArray(q.options) ? q.options : Array.isArray(o.options) ? (o.options as unknown[]) : [];
  const options: InterviewOption[] = [];
  const seen = new Set<string>();
  for (const item of rawOpts) {
    let label = "";
    let detail = "";
    if (item && typeof item === "object") {
      const r = item as Record<string, unknown>;
      label = typeof r.label === "string" ? r.label.trim() : "";
      detail = typeof r.detail === "string" ? r.detail.trim() : typeof r.description === "string" ? (r.description as string).trim() : "";
    } else if (typeof item === "string") {
      label = item.trim();
    }
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    options.push({ label, detail });
    if (options.length >= 5) break;
  }
  return { done: false, question: { question, options, recommended } };
}

/** Pure: fold the answered turns into the build prompt as confirmed details. Blank answers dropped;
 *  none → the original prompt unchanged. */
export function foldInterview(prompt: string, turns: InterviewTurn[]): string {
  const answered = turns.filter((t) => t && typeof t.answer === "string" && t.answer.trim() && typeof t.question === "string" && t.question.trim());
  if (!answered.length) return prompt;
  return `${prompt}\n\nConfirmed details about the app:\n${answered.map((t) => `- ${t.question.trim()} → ${t.answer.trim()}`).join("\n")}`;
}

const INTERVIEW_SYSTEM_PROMPT = `You are interviewing a NON-TECHNICAL person to pin down the web app they want, BEFORE it is built. You ask ONE question at a time and you already have the conversation so far. The experience must feel effortless: a single clear question with a few concrete choices to TAP — never a wall of text or an open-ended interrogation.

Decide the SINGLE most important next question — the one whose answer would most change WHAT gets built — and offer 2–4 concrete MULTIPLE-CHOICE options to pick from, marking ONE as recommended. (The UI always also lets them write their own, so you don't need a "something else" option.)

USE WHAT YOU KNOW ABOUT NAMED PRODUCTS. If the request clones or references a specific product (e.g. "a ProCare clone", a URL, "like Calendly"), draw on your knowledge of that product's REAL structure. Such products are usually large — your FIRST question should help SCOPE which part to build first, with options that reflect that product's actual modules/audiences (e.g. for ProCare: "Admin/center dashboard", "Parent portal", "Marketing site", "Full combo"). Don't make them describe a product you already understand — offer them its real slices.

How to choose the next question (branch on what they've already said):
- After scope: who uses it and who may see whose data (the costliest thing to get wrong), then key behaviours, then important edge cases.
- Do NOT ask anything already answered by the request or an earlier answer. Do NOT ask about programming technology, hosting, or frameworks.
- Gently CHALLENGE risky or scope-creepy choices via the options themselves (make the safe choice the recommended one, e.g. "Let Stripe hold card numbers (recommended)" vs "Store cards ourselves").
- CONNECTIONS ARE DISCOVERED HERE, AND ARE THE USER'S CALL: if the app needs PAYMENTS, EMAIL/SMS, or SOCIAL/SSO login, you MUST ask a question that surfaces it as a simple choice they can connect later with one click — e.g. payments: { "Use Stripe — never touch card data (recommended)", "Track payments manually", "No payments yet" }; email: { "Connect an email service to send mail", "No emails for now" }. Never silently decide these.

How much to ask:
- For ANY app that has users or stores data, ask AT LEAST 3 questions before you may stop — cover, in order: (1) scope (if a known/large product) or who-can-see-whose-data, (2) the single most important behaviour the request leaves open, (3) a key edge case OR a connection/trade-off. Ask up to ~6 if real ambiguity remains.
- Set "done": true only once you've met that minimum AND nothing left to ask would change what gets built. For a genuinely trivial tool (no users, no stored data), you may stop immediately.

Each question is ONE plain-language sentence. Each option has a short "label" and a one-line "detail" explaining the scope. "recommended" is the label of the recommended option.

Return ONLY JSON:
- to ask: { "done": false, "question": { "question": string, "options": [{ "label": string, "detail": string }], "recommended": string } }
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
  // The interview is user-facing and short — uses the "intake" stage model (a capable reasoning
  // model by default, not the fast build model). Override with VIBEHARD_MODEL_INTAKE.
  const config: EngineConfig = opts.config ?? configForStage("intake");
  return async (prompt: string, history: InterviewTurn[]) => {
    try {
      const { text } = await generateText({ model: modelFactory(config), system: INTERVIEW_SYSTEM_PROMPT, prompt: renderHistory(prompt, history), maxOutputTokens: 8000, abortSignal: AbortSignal.timeout(45_000) });
      return coerceStep(tryExtractJsonObject(text));
    } catch {
      return { done: true, question: null }; // fail-safe: any error ends the interview, build proceeds
    }
  };
}

/** Given the request + the Q&A so far, return the next question or signal done. */
export type Interviewer = (prompt: string, history: InterviewTurn[]) => Promise<InterviewStep>;
