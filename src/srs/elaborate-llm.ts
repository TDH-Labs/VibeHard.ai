/**
 * The live `Specifier` (stage 3 of the front-half): an LLM acting as a Principal Systems
 * Architect turns a PRD into an SRS draft — definitions, system functions, per-module strict
 * I/O specs + workflows + error states, external interfaces, and quantified NFRs. `coerceSrsDraft`
 * forces its JSON through the trust boundary; `assembleSrs` then derives the operating
 * environment, security posture, and compliance from the substrate (§11 — the model never
 * invents platform facts). The deterministic `reviewSrs` decides "ready", not the model.
 */
import { generateText } from "ai";
import { tryExtractJsonObject } from "../spec/index.ts";
import { isBlocking } from "../types.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import { coerceSrsDraft } from "./srs.ts";
import type { Specifier } from "./elaborate.ts";

const SRS_SYSTEM_PROMPT = `# Role
You are a Principal Systems Architect and Lead Software Engineer. You turn a PRD into a Software Requirements Specification (SRS) that engineering can implement directly. Output a single JSON object — no prose, no markdown fence.

# Directives (non-negotiable)
1. DETERMINISTIC DEFINITIONS — never use vague terms ("fast", "secure", "user-friendly", "scalable"). Define exact metrics (e.g. "p99 < 300ms", "throughput >= 50 req/s", "RAM <= 512MB"). Every NFR is a number or an explicit "TBD" backed by an open issue.
2. STRICT I/O — for EVERY functional module, specify the exact input parameters (with validation rules), the output payload structure, AND the error-handling states. No module ships without its I/O contract.
3. ZERO HALLUCINATION — if a technical detail, API dependency, or data field is missing or ambiguous in the PRD, FLAG it in openIssues. Do NOT invent it.

# Platform context (FIXED — do not re-specify; these are derived deterministically elsewhere)
The app runs on Supabase (PostgreSQL + Row-Level Security), deployed to Vercel (Next.js/Vite/static) or a Docker container on Fly. Encryption at rest (AES-256), TLS 1.3 in transit, the operating environment, and RLS data-isolation are PLATFORM FACTS handled outside this document. Do NOT put encryption/RLS/hosting/OS into your output — focus on functional behaviour, interfaces, performance, and reliability.

# Output schema
{
  "purpose": string, "audience": string, "systemScope": string,
  "definitions": [ { "term": string, "definition": string } ],
  "systemPerspective": string,
  "modules": [ string ],
  "designConstraints": [ string ],
  "functionalRequirements": [ {
    "id": "FR-1", "title": string, "description": string, "actor": string,
    "covers": ["F1"],                                  // PRD requirement ids this implements
    "inputs":  [ { "element": string, "type": string, "constraints": string, "source": string } ],
    "outputs": [ { "element": string, "type": string, "constraints": string, "source": string } ],
    "workflow": [ string ],                            // step-by-step processing logic
    "errors": [ { "condition": string, "action": string, "response": string } ]
  } ],
  "uiRequirements": [ string ],                        // BEHAVIOUR only (responsiveness, WCAG 2.1 AA) — not visual style
  "apiInterfaces": [ { "target": string, "protocol": string, "purpose": string, "dataFormat": string } ],
  "performance": { "throughput": string, "latencyP99": string, "resourceLimit": string },
  "reliability": { "uptime": string, "rpo": string, "rto": string },
  "openIssues": [ { "ref": "TECH-001", "description": string, "module": string } ],
  "dataModel": [ { "name": string, "fields": [string], "notes": string } ]
}

# Rules
- Organise §3 by MODULE/epic, NOT one functional requirement per PRD line. Produce 3-6 functional requirements total, each a cohesive module (e.g. "Authentication & Session", "Appointments", "Session Notes"). Every PRD requirement id (F1, F2…) MUST appear in the "covers" of exactly one module.
- BE CONCISE so the whole JSON fits in one response: per module list the KEY inputs/outputs (not every field), 3-6 workflow steps, and the main error states. Use short phrases, never paragraphs. A truncated document is a failed document.
- Each functional requirement MUST still specify inputs and/or outputs (validation in "constraints"), a "workflow", AND error states (auth, validation, not-found, conflict).
- performance/reliability values MUST be concrete numbers. If a target genuinely cannot be derived from the PRD, write "TBD" AND add a matching openIssues entry — NEVER a vague adjective.
- apiInterfaces: list the external services the PRD's buy-vs-build implies (e.g. Stripe, Clerk, Resend) plus Supabase REST/Auth. dataModel: draft entities + fields from the PRD's data and acceptance criteria.
- Flag every genuine unknown or contradiction in openIssues (zero hallucination). If given previous gaps, FIX every one.`;

export interface LlmSpecifierOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

export function llmSpecifier(opts: LlmSpecifierOptions = {}): Specifier {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config: EngineConfig =
    opts.config ??
    (process.env.OPENCODE_API_KEY ? { provider: "opencode", model: "deepseek-v4-pro" } : { provider: "anthropic", model: "claude-opus-4-8" });

  return async (prd, prior) => {
    const prdView = {
      name: prd.spec.name,
      objectives: prd.objectives,
      requirements: prd.requirements.map((r) => ({ id: r.id, feature: r.feature, detail: r.detail, acceptance: r.acceptance })),
      scenarios: prd.scenarios.map((s) => ({ id: s.id, action: s.action, outcome: s.outcome })),
      dataEntities: prd.spec.dataEntities,
      buyVsBuild: prd.buyVsBuild.map((b) => ({ category: b.category, service: b.service })),
      storesData: prd.spec.storesData,
    };
    const base = `PRD:\n${JSON.stringify(prdView, null, 2)}`;
    const blocking = prior?.gaps.filter(isBlocking) ?? [];
    const user = prior
      ? [base, "", "Your previous SRS draft had these BLOCKING gaps — fix every one:", ...blocking.map((g) => `- ${g.message}`), "", "Return the corrected SRS JSON."].join("\n")
      : `${base}\n\nReturn the SRS JSON.`;

    const { text, finishReason } = await generateText({ model: modelFactory(config), system: SRS_SYSTEM_PROMPT, prompt: user, maxOutputTokens: 16000 });
    const obj = tryExtractJsonObject(text);
    // A "length" finishReason means the model truncated mid-JSON → unparseable → empty draft;
    // the concise module-level prompt keeps the document within one response. Resilient either
    // way: a malformed response coerces to a near-empty draft that reviewSrs flags for a retry.
    if (process.env.SRS_DEBUG) console.error(`[srs] text.len=${text.length} finish=${finishReason} parsed=${obj !== null}`);
    return coerceSrsDraft(obj);
  };
}
