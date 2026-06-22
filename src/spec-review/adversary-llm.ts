/**
 * The live `Adversary` (the LLM red-team half of the front-half review). It is
 * prompted to REFUTE the plan — assume it's flawed and find the flaws — across
 * diverse lenses, rather than asked "does this look fine?" (which a model rubber-
 * stamps). Output is ADVISORY (it surfaces risks; the deterministic cross-checks and
 * the human dispose — §11). Reuses the engine ModelFactory; coerces the findings
 * through a trust boundary.
 *
 * Honest limit: an LLM reviewing an LLM's plan has correlated blind spots — this
 * reduces risk, it doesn't eliminate it. The human stays the ultimate front-half judge.
 */
import { generateText } from "ai";
import { tryExtractJsonObject } from "../spec/index.ts";
import type { EngineConfig, Finding } from "../types.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import type { Adversary, FrontHalfBundle } from "./review.ts";

const ADVERSARY_SYSTEM_PROMPT = `You are a SKEPTICAL senior reviewer. Find what is WRONG with this plan (spec → PRD → architecture) BEFORE it is built. Assume it is flawed and look hard — do NOT rubber-stamp. Cover these lenses:
- security/privacy: hidden sensitive data the spec didn't flag, a missing protection, an auth/tenant boundary the design crosses or omits.
- scope/feasibility: scope creep, or something that can't realistically be built as described.
- intent-fidelity: does it build what was actually asked? a requirement with no basis in the spec (a hallucination)? a feature quietly lost?
- architecture soundness: a single point of failure, a missing data/auth layer, a workstream that can't be built from the PRD.

Return ONLY a JSON object (no prose, no fence): {"findings":[{"lens": string, "severity":"low"|"medium"|"high", "issue": string, "where": string}]}.
List only genuine, specific concerns. If after looking hard it is sound, return an empty findings array — but you must have looked hard.`;

const SEVERITIES = new Set(["low", "medium", "high"]);

/** Trust boundary: coerce the red-team's JSON into advisory Finding[]. */
export function coerceAdversarialFindings(raw: unknown): Finding[] {
  const arr = raw && typeof raw === "object" && Array.isArray((raw as { findings?: unknown }).findings) ? ((raw as { findings: unknown[] }).findings) : [];
  const out: Finding[] = [];
  for (const v of arr) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const issue = typeof o.issue === "string" ? o.issue.trim() : "";
    if (!issue) continue;
    const severity = (typeof o.severity === "string" && SEVERITIES.has(o.severity) ? o.severity : "medium") as Finding["severity"];
    const lens = typeof o.lens === "string" && o.lens.trim() ? o.lens.trim() : "review";
    out.push({ tool: "spec-review", ruleId: "spec-risk", severity, file: typeof o.where === "string" && o.where ? o.where : "front-half", message: `[${lens}] ${issue}` });
  }
  return out;
}

export interface LlmAdversaryOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

export function llmAdversary(opts: LlmAdversaryOptions = {}): Adversary {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config: EngineConfig =
    opts.config ??
    (process.env.OPENCODE_API_KEY ? { provider: "opencode", model: "deepseek-v4-pro" } : { provider: "anthropic", model: "claude-opus-4-8" });

  return async (bundle: FrontHalfBundle) => {
    const summary = {
      spec: { name: bundle.spec.name, summary: bundle.spec.summary, features: bundle.spec.features, tenancy: bundle.spec.tenancy, auth: bundle.spec.auth, sensitiveData: bundle.spec.sensitiveData, dataEntities: bundle.spec.dataEntities },
      prd: { requirements: bundle.prd.requirements, nfrs: bundle.prd.nfrs, buyVsBuild: bundle.prd.buyVsBuild },
      architecture: { stack: bundle.architecture.stack, workstreams: bundle.architecture.workstreams },
    };
    const { text } = await generateText({ model: modelFactory(config), system: ADVERSARY_SYSTEM_PROMPT, prompt: `Plan to review:\n${JSON.stringify(summary)}`, maxOutputTokens: 4000 });
    return coerceAdversarialFindings(tryExtractJsonObject(text));
  };
}
