/**
 * Change requests (EPIC #52), stage 1: the customer's words → a structured, validated delta
 * against the app's existing spec. The LLM PROPOSES the delta (it's a language task); every
 * decision about whether it's coherent is deterministic (§11):
 *   • every modified/removed feature must NAME an existing spec feature exactly;
 *   • every added feature must carry checkable acceptance criteria (they feed the PRD, the
 *     completeness gate, and property-test generation);
 *   • at least one action — an empty delta is a conversation, not a change.
 * The persisted .vibehard/changes/<n>.json is the audit trail: what was asked, what was
 * understood, and when.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateTextResilient, defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import type { EngineConfig } from "../types.ts";
import { configForStage } from "../config/models.ts";
import { tryExtractJsonObject } from "../spec/coerce.ts";
import type { Spec } from "../spec/index.ts";

export interface AddedFeature {
  feature: string;
  /** Checkable acceptance criteria — required, they become the PRD requirement's. */
  acceptance: string[];
}
export interface ModifiedFeature {
  /** Must exactly match an existing spec feature. */
  feature: string;
  change: string;
  /** When the change alters what "correct" means, the replacement criteria. */
  acceptance?: string[];
}

export interface ChangeDelta {
  request: string;
  summary: string;
  add: AddedFeature[];
  modify: ModifiedFeature[];
  remove: string[]; // must exactly match existing spec features
  at: string;
}

const DELTA_SYSTEM_PROMPT = `You turn a customer's change request for an EXISTING app into a structured delta against the app's feature list.

Reply with ONLY a JSON object:
{
  "summary": string,                    // one line: what changes
  "add":    [ { "feature": string, "acceptance": [string, ...] } ],
  "modify": [ { "feature": string, "change": string, "acceptance": [string, ...]? } ],
  "remove": [ string ]
}

Rules:
- "modify" and "remove" entries must copy an existing feature EXACTLY as it appears in the list you are given.
- Every added feature needs specific, checkable acceptance criteria (like "a visitor can join the waitlist with name + email"), never vague ones ("works well").
- Include "acceptance" on a modify ONLY when the change redefines what correct behavior is.
- Decompose the request into the smallest set of feature-level entries. If the request is a question or contains no actionable change, return {"summary": "...", "add": [], "modify": [], "remove": []}.`;

export interface DeltaOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
  /** test seam: one model call (system, prompt) → raw text. */
  generate?: (system: string, prompt: string) => Promise<string>;
}

/** Trust boundary: coerce whatever the model returned into a ChangeDelta shape. Pure. */
export function coerceDelta(raw: unknown, request: string, at: string): ChangeDelta {
  const o = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  const add: AddedFeature[] = Array.isArray(o.add)
    ? o.add.flatMap((a) => {
        const f = str((a as Record<string, unknown>)?.feature);
        return f ? [{ feature: f, acceptance: strArr((a as Record<string, unknown>)?.acceptance) }] : [];
      })
    : [];
  const modify: ModifiedFeature[] = Array.isArray(o.modify)
    ? o.modify.flatMap((m) => {
        const rec = (m ?? {}) as Record<string, unknown>;
        const f = str(rec.feature);
        const acceptance = strArr(rec.acceptance);
        return f ? [{ feature: f, change: str(rec.change), ...(acceptance.length ? { acceptance } : {}) }] : [];
      })
    : [];
  return { request, summary: str(o.summary), add, modify, remove: strArr(o.remove), at };
}

/** Deterministic dispose: the reasons this delta is incoherent against the spec, or []. Pure. */
export function validateDelta(delta: ChangeDelta, spec: Spec): string[] {
  const problems: string[] = [];
  const features = new Set(spec.features);
  for (const m of delta.modify) {
    if (!features.has(m.feature)) problems.push(`modify targets "${m.feature}", which is not an existing feature`);
    if (!m.change) problems.push(`modify of "${m.feature}" has no change description`);
  }
  for (const r of delta.remove) {
    if (!features.has(r)) problems.push(`remove targets "${r}", which is not an existing feature`);
  }
  for (const a of delta.add) {
    if (features.has(a.feature)) problems.push(`add duplicates existing feature "${a.feature}" — use modify`);
    if (!a.acceptance.length) problems.push(`added feature "${a.feature}" has no acceptance criteria`);
  }
  if (!delta.add.length && !delta.modify.length && !delta.remove.length) {
    problems.push("the request contains no actionable change (nothing to add, modify, or remove)");
  }
  return problems;
}

/** The LLM proposing seam: request + current features → coerced (NOT yet validated) delta. */
export async function llmChangeDelta(request: string, spec: Spec, at: string, opts: DeltaOptions = {}): Promise<ChangeDelta> {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config: EngineConfig = opts.config ?? configForStage("intake");
  const generate =
    opts.generate ??
    (async (system: string, prompt: string) => {
      const { text } = await generateTextResilient({ model: modelFactory(config), system, prompt, maxOutputTokens: 4000 }, { timeoutMs: 60_000 });
      return text;
    });
  const prompt = [`Existing app: ${spec.name} — ${spec.summary}`, `Existing features:`, ...spec.features.map((f) => `- ${f}`), ``, `Change request:`, request].join("\n");
  const raw = tryExtractJsonObject(await generate(DELTA_SYSTEM_PROMPT, prompt));
  return coerceDelta(raw, request, at);
}

/** Persist the delta as the next .vibehard/changes/<n>.json — the append-only audit trail. */
export function persistChange(target: string, delta: ChangeDelta): string {
  const dir = join(target, ".vibehard", "changes");
  mkdirSync(dir, { recursive: true });
  const n = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).length + 1 : 1;
  const rel = join(".vibehard", "changes", `${n}.json`);
  writeFileSync(join(target, rel), `${JSON.stringify(delta, null, 2)}\n`);
  return rel;
}
