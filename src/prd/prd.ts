/**
 * The PRD — stage 2 of the front-half (PROJECT_BRIEF.md §22): the Spec elaborated into a
 * Principal-PM-grade Product Requirements Document. Where the Spec is the grilled INTENT
 * (what + for whom + how sensitive), the PRD is the full requirements doc: a one-pager
 * (overview, problem, objectives, constraints), target personas, end-to-end scenarios,
 * in-scope features (each with priority, acceptance criteria, and a use-case reference) and
 * explicit out-of-scope, success metrics, and risks — PLUS the derived security posture
 * (NFRs) and buy-vs-build advisories.
 *
 * Division of labour (§11): an LLM PROPOSES the strategic/functional content (elaborate.ts);
 * this module is the deterministic DISPOSER — it DERIVES the NFRs from the spec, runs
 * buy-vs-build, and CHECKS the PRD for completeness AND logical consistency (every in-scope
 * feature must trace to a scenario, every reference must resolve) before it can feed the
 * architecture stage. The human-process fields (sign-off, owners) are not invented by the
 * AI — they render as "pending human review", which is exactly our escalation model.
 */
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";
import { isSensitive, securityRequirements, type Spec } from "../spec/index.ts";
import { buyVsBuild, type BuyVsBuild } from "./buy-vs-build.ts";

/** A target user of the product. Primary = the core user the build serves first. */
export interface Persona {
  name: string; // role/label, e.g. "Clinic front-desk coordinator"
  kind: "primary" | "secondary";
  description: string; // behaviour + motivation
}

/** An end-to-end narrative: a persona, in a context, takes an action, gets an outcome. */
export interface Scenario {
  id: string; // S1, S2 … — referenced by in-scope features
  persona: string; // the persona name this scenario is about
  context: string;
  action: string;
  outcome: string;
}

/** One feature elaborated into a buildable requirement, scoped + traced to a scenario. */
export interface Requirement {
  id: string; // F1, F2 … (stable handle for the in-scope table)
  feature: string; // the spec feature this elaborates (EXACT spec text — links back for coverage)
  detail: string; // what it concretely entails + the user value
  acceptance: string[]; // testable acceptance criteria — how we know it's done
  priority: "MVP" | "P1" | "P2"; // MVP = launch-blocking
  scenarioRefs: string[]; // which scenario id(s) this feature serves (logical-consistency trace)
}

/** A capability intentionally excluded this cycle, with the reason (scope-creep guard). */
export interface OutOfScope {
  feature: string;
  reason: string;
}

/** A quantitative measure of whether the build met its objectives. */
export interface SuccessMetric {
  kind: "primary" | "secondary";
  metric: string; // e.g. "% of clients who complete onboarding without support"
  target?: string; // e.g. "> 80% in first 30 days" (optional — the AI shouldn't fabricate baselines)
}

/** An open risk with an impact rating and a mitigation. */
export interface Risk {
  risk: string;
  impact: "H" | "M" | "L";
  mitigation: string;
}

/**
 * What the LLM PROPOSES — the strategic + functional PRD content. The security NFRs and the
 * buy-vs-build advisories are NOT here: they are derived deterministically in assemblePrd.
 */
export interface PrdDraft {
  title: string;
  overview: string;
  problemStatement: string;
  objectives: string[];
  constraints: string[]; // constraints & dependencies that bound the build
  personas: Persona[];
  scenarios: Scenario[];
  requirements: Requirement[]; // the in-scope features
  outOfScope: OutOfScope[];
  successMetrics: SuccessMetric[];
  risks: Risk[];
  openQuestions: string[];
}

/** The assembled PRD: the proposed draft + the spec + the DERIVED security/procurement halves. */
export interface Prd extends PrdDraft {
  spec: Spec; // the source spec, carried for traceability
  status: "in-review"; // AI-authored → always pending human sign-off
  nfrs: string[]; // non-functional requirements (the security posture + retention) — DERIVED
  buyVsBuild: BuyVsBuild[]; // advisories — buy a mature service vs build it — DERIVED
}

/** An empty draft — the degenerate artifact a malformed LLM response coerces to, so the
 *  review loop flags gaps and retries rather than the build crashing. */
export function emptyDraft(spec: Spec): PrdDraft {
  return {
    title: `PRD for ${spec.name}`,
    overview: "",
    problemStatement: "",
    objectives: [],
    constraints: [],
    personas: [],
    scenarios: [],
    requirements: [],
    outOfScope: [],
    successMetrics: [],
    risks: [],
    openQuestions: [],
  };
}

/** Deterministic: the NFRs implied by the spec. The security posture (reused from the
 *  spec's `securityRequirements`) is the bulk — already consequence-framed and
 *  gate-pre-empting. The LLM never invents the security NFRs; they're derived. */
export function deriveNfrs(spec: Spec): string[] {
  return securityRequirements(spec);
}

/** Assemble a PRD from the spec + the LLM's draft: NFRs and buy-vs-build are DERIVED here
 *  (deterministic), never trusted from the model; status is always "in-review". */
export function assemblePrd(spec: Spec, draft: PrdDraft): Prd {
  return { ...draft, spec, status: "in-review", nfrs: deriveNfrs(spec), buyVsBuild: buyVsBuild(spec) };
}

const gap = (ruleId: string, severity: Finding["severity"], message: string): Finding => ({
  tool: "prd",
  ruleId,
  severity,
  file: "PRD",
  message,
});

/**
 * Deterministic completeness + consistency check on the elaborated PRD. Blocking (high) when
 * the PRD couldn't feed the architecture stage honestly: requirements don't cover the spec, a
 * requirement has no acceptance criteria, a sensitive app has no security NFRs, OR the
 * strategic spine is missing/inconsistent (no problem, objectives, personas, scenarios,
 * metrics; or a feature referencing a scenario that doesn't exist). Advisory (medium) for
 * softer PM-quality nudges (a feature tracing to no scenario; nothing marked out-of-scope).
 */
export function reviewPrd(prd: Prd): Finding[] {
  const out: Finding[] = [];

  // ── functional completeness (the original contract — architecture depends on it) ──
  const covered = new Set(prd.requirements.map((r) => r.feature));
  const uncovered = prd.spec.features.filter((f) => !covered.has(f));
  if (uncovered.length) {
    out.push(gap("requirement-coverage-gap", "high", `These spec features have no in-scope requirement yet: ${uncovered.join("; ")}.`));
  }

  const noAccept = prd.requirements.filter((r) => r.acceptance.length === 0).map((r) => r.feature || r.detail || r.id);
  if (noAccept.length) {
    out.push(gap("no-acceptance-criteria", "high", `Requirements with no acceptance criteria (no way to tell when they're done): ${noAccept.join("; ")}.`));
  }

  if (isSensitive(prd.spec) && prd.nfrs.length === 0) {
    out.push(gap("no-nfrs", "high", "Sensitive app, but the PRD states no non-functional (security) requirements."));
  }

  // ── strategic spine (the one-pager must be aligned before deep requirements) ──
  if (!prd.problemStatement.trim()) {
    out.push(gap("no-problem-statement", "high", "The PRD has no problem statement — the 'why now' the rest must line up against."));
  }
  if (prd.objectives.length === 0) {
    out.push(gap("no-objectives", "high", "The PRD defines no objectives — there's nothing to judge the features (or success) against."));
  }
  if (!prd.personas.some((p) => p.kind === "primary")) {
    out.push(gap("no-primary-persona", "high", "The PRD names no primary persona — who the build serves first is undefined."));
  }
  if (prd.scenarios.length === 0) {
    out.push(gap("no-scenarios", "high", "The PRD has no user scenarios — features can't be traced to real usage."));
  }
  if (prd.successMetrics.length === 0) {
    out.push(gap("no-success-metrics", "high", "The PRD defines no success metrics — there's no way to tell if the build worked."));
  }

  // ── logical consistency (the PM 'every reference resolves' guarantee) ──
  const scenarioIds = new Set(prd.scenarios.map((s) => s.id));
  const personaNames = new Set(prd.personas.map((p) => p.name));
  const brokenRefs = prd.requirements.filter((r) => r.scenarioRefs.some((ref) => !scenarioIds.has(ref)));
  if (brokenRefs.length) {
    out.push(gap("broken-scenario-ref", "high", `These features reference a scenario that doesn't exist: ${brokenRefs.map((r) => r.id || r.feature).join("; ")}.`));
  }
  const orphanScenarioPersona = prd.scenarios.filter((s) => !personaNames.has(s.persona)).map((s) => s.id);
  if (orphanScenarioPersona.length) {
    out.push(gap("scenario-unknown-persona", "high", `These scenarios reference a persona not in the personas list: ${orphanScenarioPersona.join("; ")}.`));
  }

  // ── advisory PM-quality nudges (medium — surfaced, never block the build) ──
  const untraced = prd.requirements.filter((r) => r.scenarioRefs.length === 0).map((r) => r.id || r.feature);
  if (untraced.length) {
    out.push(gap("feature-untraced", "medium", `In-scope features that trace to no scenario (verify they're truly needed): ${untraced.join("; ")}.`));
  }
  if (prd.outOfScope.length === 0) {
    out.push(gap("no-out-of-scope", "medium", "Nothing is marked out-of-scope — explicit exclusions prevent scope creep."));
  }

  return out;
}

/** Gate-style verdict for the PRD readiness check (block iff a blocking gap). */
export function prdReviewVerdict(prd: Prd, ranAt: string = new Date().toISOString()): GateVerdict {
  return verdictOf("prd", reviewPrd(prd), ranAt);
}

// ── trust boundary: coerce the LLM's JSON into valid shapes, never trust the model (§11) ──

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);

/** Coerce the LLM's requirements JSON into valid Requirement[] — drop malformed, assign
 *  stable F-ids when missing, coerce priority/refs; never trust the model's shape. */
export function coerceRequirements(raw: unknown): Requirement[] {
  if (!Array.isArray(raw)) return [];
  const out: Requirement[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const feature = str(o.feature);
    const detail = str(o.detail);
    if (!feature && !detail) continue;
    out.push({
      id: str(o.id) || `F${out.length + 1}`,
      feature,
      detail,
      acceptance: strArr(o.acceptance),
      priority: oneOf(o.priority, ["MVP", "P1", "P2"] as const, "MVP"),
      scenarioRefs: strArr(o.scenarioRefs),
    });
  }
  return out;
}

function coercePersonas(raw: unknown): Persona[] {
  if (!Array.isArray(raw)) return [];
  const out: Persona[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const name = str(o.name);
    if (!name) continue;
    out.push({ name, kind: oneOf(o.kind, ["primary", "secondary"] as const, out.length === 0 ? "primary" : "secondary"), description: str(o.description) });
  }
  return out;
}

function coerceScenarios(raw: unknown): Scenario[] {
  if (!Array.isArray(raw)) return [];
  const out: Scenario[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const persona = str(o.persona);
    const action = str(o.action);
    if (!persona && !action) continue;
    out.push({ id: str(o.id) || `S${out.length + 1}`, persona, context: str(o.context), action, outcome: str(o.outcome) });
  }
  return out;
}

function coerceOutOfScope(raw: unknown): OutOfScope[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map((o) => ({ feature: str(o.feature), reason: str(o.reason) }))
    .filter((x) => x.feature);
}

function coerceMetrics(raw: unknown): SuccessMetric[] {
  if (!Array.isArray(raw)) return [];
  const out: SuccessMetric[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const metric = str(o.metric);
    if (!metric) continue;
    const target = str(o.target);
    out.push({ kind: oneOf(o.kind, ["primary", "secondary"] as const, "primary"), metric, ...(target ? { target } : {}) });
  }
  return out;
}

function coerceRisks(raw: unknown): Risk[] {
  if (!Array.isArray(raw)) return [];
  const out: Risk[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const risk = str(o.risk);
    if (!risk) continue;
    out.push({ risk, impact: oneOf(o.impact, ["H", "M", "L"] as const, "M"), mitigation: str(o.mitigation) });
  }
  return out;
}

/** The top-level trust boundary: coerce the LLM's full PRD JSON into a valid PrdDraft. */
export function coercePrdDraft(raw: unknown, spec: Spec): PrdDraft {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    title: str(o.title) || `PRD for ${spec.name}`,
    overview: str(o.overview),
    problemStatement: str(o.problemStatement),
    objectives: strArr(o.objectives),
    constraints: strArr(o.constraints),
    personas: coercePersonas(o.personas),
    scenarios: coerceScenarios(o.scenarios),
    requirements: coerceRequirements(o.requirements),
    outOfScope: coerceOutOfScope(o.outOfScope),
    successMetrics: coerceMetrics(o.successMetrics),
    risks: coerceRisks(o.risks),
    openQuestions: strArr(o.openQuestions),
  };
}

// ── rendering: the human-readable PRD document (the operator/reviewer deliverable) ──

/** Render the PRD as a professional Markdown document (the full template). This is what the
 *  operator + the human reviewer read; it's persisted alongside the build. */
export function renderPrdMarkdown(prd: Prd): string {
  const L: string[] = [];
  const h = (s: string) => L.push(`\n## ${s}\n`);
  const checklist = prdChecklist(prd);

  L.push(`# ${prd.title}`);
  L.push(`\n**Author:** VibeHard (AI) · **Status:** In Review (pending human sign-off) · **Source spec:** ${prd.spec.name}`);

  h("Overview");
  L.push(prd.overview || "_—_");

  h("Problem Statement");
  L.push(prd.problemStatement || "_—_");

  h("Objectives");
  prd.objectives.forEach((o, i) => L.push(`${i + 1}. ${o}`));

  h("Constraints & Dependencies");
  if (prd.constraints.length) prd.constraints.forEach((c) => L.push(`- ${c}`));
  else L.push("_None identified._");

  h("Target Personas");
  for (const p of prd.personas) L.push(`- **${p.name}** (${p.kind}) — ${p.description}`);

  h("User Use Cases & Scenarios");
  for (const s of prd.scenarios) L.push(`- **${s.id} (${s.persona}):** ${s.context} → ${s.action} → _${s.outcome}_`);

  h("Features In-Scope");
  L.push("| ID | Feature | Priority | Description & User Value | Use Case |");
  L.push("|----|---------|----------|--------------------------|----------|");
  for (const r of prd.requirements) {
    L.push(`| ${r.id} | ${r.feature} | ${r.priority} | ${r.detail} | ${r.scenarioRefs.join(", ") || "—"} |`);
  }
  for (const r of prd.requirements.filter((x) => x.acceptance.length)) {
    L.push(`\n**${r.id} acceptance:**`);
    r.acceptance.forEach((a) => L.push(`  - ${a}`));
  }

  h("Features Out-of-Scope");
  if (prd.outOfScope.length) for (const o of prd.outOfScope) L.push(`- **${o.feature}** — _${o.reason}_`);
  else L.push("_Nothing explicitly excluded._");

  h("Non-Functional Requirements (Security Posture — derived, enforced by the gates)");
  if (prd.nfrs.length) prd.nfrs.forEach((n) => L.push(`- ${n}`));
  else L.push("_None (non-sensitive app)._");

  if (prd.buyVsBuild.length) {
    h("Buy-vs-Build (advisory)");
    for (const b of prd.buyVsBuild) L.push(`- **${b.category}** → consider \`${b.service}\` — ${b.rationale}`);
  }

  h("Success Metrics (KPIs)");
  for (const m of prd.successMetrics) L.push(`- **${m.kind === "primary" ? "Primary" : "Secondary"}:** ${m.metric}${m.target ? ` — target: ${m.target}` : ""}`);

  if (prd.risks.length) {
    h("Open Issues / Risks");
    L.push("| Risk | Impact | Mitigation |");
    L.push("|------|--------|------------|");
    for (const r of prd.risks) L.push(`| ${r.risk} | ${r.impact} | ${r.mitigation} |`);
  }

  if (prd.openQuestions.length) {
    h("Open Questions");
    prd.openQuestions.forEach((q) => L.push(`- ${q}`));
  }

  h("Stakeholder Sign-Off");
  L.push("- Product / Engineering / Design review: **pending human review** (VibeHard routes high-risk PRDs to a human reviewer before build).");

  h("PRD Checklist");
  for (const c of checklist) L.push(`- [${c.ok ? "x" : " "}] ${c.label}`);

  return L.join("\n");
}

/** The template's checklist, auto-evaluated against what the PRD actually contains. */
export function prdChecklist(prd: Prd): Array<{ ok: boolean; label: string }> {
  return [
    { ok: !!prd.title && !!prd.overview, label: "Title, overview, and authorship present" },
    { ok: !!prd.problemStatement.trim(), label: "Problem statement articulated" },
    { ok: prd.objectives.length > 0, label: "Objectives defined" },
    { ok: prd.successMetrics.length > 0, label: "Explicit success metrics established" },
    { ok: prd.requirements.length > 0 && prd.outOfScope.length > 0, label: "Scope split into In vs Out" },
    { ok: prd.requirements.every((r) => r.scenarioRefs.length > 0) && prd.scenarios.length > 0, label: "Scenarios tie features back to personas" },
    { ok: !isSensitive(prd.spec) || prd.nfrs.length > 0, label: "Security/compliance NFRs derived for sensitive data" },
  ];
}
