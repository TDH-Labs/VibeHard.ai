/**
 * Functional review (backlog #11). The verify gate proves an app BOOTS and answers HTTP; it does
 * not prove the app DOES what the user asked. This is the first half of "does it actually work":
 * an LLM QA tester inspects the generated code against the requirements (the SRS functional
 * requirements / the prompt's features) and judges, per feature, whether it's implemented
 * end-to-end ("works"), started-but-incomplete ("partial"), or absent ("missing").
 *
 * HONEST SCOPE: this is a code-level functional-COVERAGE check, not a runtime drive of the live
 * app. It catches "the build is missing / stubbed a feature you asked for" without browser infra.
 * The heavier follow-on — an LLM driving the deployed app like a user — needs a headless browser +
 * a publicly reachable URL + a test account, and is tracked separately.
 *
 * Advisory (never blocks): a report the operator + user read. `coerceChecks` is the trust boundary;
 * the LLM proposes, a human disposes.
 */
import { configForStage } from "../config/models.ts";
import { readAppSources } from "../gate/rls.ts";
import { tryExtractJsonObject } from "../spec/index.ts";
import { defaultModelFactory, generateTextResilient, type ModelFactory } from "../engine/bolt/driver.ts";
import type { EngineConfig } from "../types.ts";

/** Thrown when the reviewer was ASKED to judge real features over real sources but the model
 *  produced no usable output (empty/unparseable, even after a retry). Distinct from a legitimate
 *  N/A (no features / no sources → []), so a caller like the completeness gate can fail CLOSED
 *  on "couldn't verify" instead of mistaking it for "nothing to flag" (a false pass). */
export class FunctionalReviewUnavailable extends Error {}

export type CheckStatus = "works" | "partial" | "missing";

export interface FunctionalCheck {
  feature: string;
  status: CheckStatus;
  note: string; // why — what's present / what's stubbed or absent
}

const STATUSES: readonly CheckStatus[] = ["works", "partial", "missing"];

/** Trust boundary: coerce the model's JSON into valid, de-duplicated checks. */
export function coerceChecks(raw: unknown): FunctionalCheck[] {
  const o = raw && typeof raw === "object" ? (raw as { checks?: unknown }) : {};
  const arr = Array.isArray(o.checks) ? o.checks : Array.isArray(raw) ? (raw as unknown[]) : [];
  const out: FunctionalCheck[] = [];
  const seen = new Set<string>();
  for (const c of arr) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const feature = typeof r.feature === "string" ? r.feature.trim() : "";
    if (!feature || seen.has(feature)) continue;
    const status: CheckStatus = STATUSES.includes(r.status as CheckStatus) ? (r.status as CheckStatus) : "partial";
    const note = typeof r.note === "string" ? r.note.trim() : "";
    seen.add(feature);
    out.push({ feature, status, note });
    if (out.length >= 25) break;
  }
  return out;
}

/** Roll the checks into a one-line verdict for the operator/UI. */
export function summarize(checks: FunctionalCheck[]): { works: number; partial: number; missing: number; total: number } {
  return {
    works: checks.filter((c) => c.status === "works").length,
    partial: checks.filter((c) => c.status === "partial").length,
    missing: checks.filter((c) => c.status === "missing").length,
    total: checks.length,
  };
}

const FUNCTEST_SYSTEM_PROMPT = `You are a QA tester checking whether a generated web app actually IMPLEMENTS what the user asked for. For EACH feature/flow listed, inspect the code and decide:
- "works": implemented end-to-end (the UI exists AND it's wired to real data/logic that would plausibly function),
- "partial": started but incomplete or faked — e.g. a button with no handler, a form that doesn't persist, hardcoded/mock data, a TODO, a route that renders nothing useful,
- "missing": not implemented at all.

Be SKEPTICAL and concrete. A screen that renders but doesn't save or load real data is "partial", not "works". In each note, point to what made you decide (a file/handler that exists, or what's absent/stubbed).

Return ONLY JSON: { "checks": [ { "feature": string, "status": "works" | "partial" | "missing", "note": string } ] }`;

const SOURCE_CAP = 90_000;
function sourceBlock(sources: Array<{ file: string; code: string }>): string {
  const out: string[] = [];
  let total = 0;
  for (const { file, code } of sources) {
    if (total >= SOURCE_CAP) break;
    total += code.length;
    out.push(`--- ${file} ---\n${code}`);
  }
  return out.join("\n\n");
}

export interface FunctionalReviewer {
  (features: string[], workspace: string): Promise<FunctionalCheck[]>;
}

export interface FunctionalReviewOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

/** The live functional reviewer — one model call over the features + the app's code. */
export function llmFunctionalReviewer(opts: FunctionalReviewOptions = {}): FunctionalReviewer {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config = opts.config ?? configForStage("functest");
  return async (features, workspace) => {
    const cleaned = features.map((f) => f.trim()).filter(Boolean);
    if (!cleaned.length) return []; // legitimate N/A — nothing to review
    const sources = await readAppSources(workspace);
    if (!sources.length) return []; // legitimate N/A — no app code to read
    const prompt = `Features the app must have:\n${cleaned.map((f) => `- ${f}`).join("\n")}\n\nThe app's code:\n\n${sourceBlock(sources)}`;
    // The light tier is a REASONING model — it spends output tokens THINKING before emitting the
    // JSON. At 4k that budget was eaten by reasoning → empty text → coerceChecks([]) → a caller
    // reading [] as "nothing missing" → FALSE PASS (observed: same source judged "7 missing" then
    // "all present" on consecutive runs). Give it real headroom, and retry once before giving up.
    let lastLen = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      let text = "";
      try {
        // retries: 0 — this loop IS the retry policy here, and the wrapper now throws on a
        // whitespace-only response, which this reviewer must convert to its own loud
        // FunctionalReviewUnavailable rather than let escape as a generic error.
        ({ text } = await generateTextResilient(
          {
            model: modelFactory(config),
            system: FUNCTEST_SYSTEM_PROMPT,
            prompt,
            maxOutputTokens: 16_000,
            temperature: 0, // judge the SAME code the same way every round — sampling variance made the
            // completeness verdict wobble (a feature flagged missing one round, present the next),
            // which stops a finished build from converging (completeness is never green at the same
            // time as the other gates). Greedy decoding makes the grade stable + reproducible.
          },
          { retries: 0 },
        ));
      } catch {
        text = ""; // an unusable response counts as a failed attempt of THIS loop
      }
      lastLen = (text ?? "").length;
      const checks = coerceChecks(tryExtractJsonObject(text ?? ""));
      if (checks.length) return checks;
    }
    // Asked to judge real features over real sources, got nothing usable twice → fail LOUD, not [].
    throw new FunctionalReviewUnavailable(`functional reviewer produced no usable checks for ${cleaned.length} feature(s) over ${sources.length} source file(s) (model=${config.model}; last response ${lastLen} chars)`);
  };
}
