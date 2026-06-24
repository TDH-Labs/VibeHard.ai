/**
 * The SRS — stage 3 of the front-half (between PRD and architecture). Where the PRD is the
 * PRODUCT requirements (what + for whom + why), the SRS is the SOFTWARE requirements: a
 * Principal-Systems-Architect document with deterministic definitions (exact metrics, not
 * "fast"/"secure"), strict per-module I/O specs (inputs + validation + outputs + error
 * states), external interfaces, and quantified NFRs — feeding the architecture stage.
 *
 * Division of labour (§11): an LLM PROPOSES the technical functional detail (elaborate.ts);
 * this module is the deterministic DISPOSER. Crucially, the directive's "deterministic
 * definitions / zero hallucination" is satisfied by DERIVING the operating environment,
 * security posture, and compliance from VibeHard's KNOWN substrate (Supabase Postgres + RLS,
 * AES-256 at rest, TLS 1.3, Vercel/Fly) — those are platform FACTS, not model guesses. The
 * LLM fills functional behaviour and flags genuine unknowns in Open Technical Issues.
 */
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";
import { isSensitive, type Spec } from "../spec/index.ts";
import type { Prd } from "../prd/index.ts";

// ── §1.3 / §2 / §3 / §4 / §6 — LLM-proposed shapes ──────────────────────────────
export interface Definition {
  term: string;
  definition: string;
}

/** One field in a module's input or output contract (§3.X.1 strict I/O). */
export interface IoField {
  element: string; // e.g. "user_id"
  type: string; // e.g. "UUIDv4", "JSON", "ISO-8601 string"
  constraints: string; // validation rules, e.g. "not null; must exist in users"
  source: string; // e.g. "API request body", "JWT claim", "DB"
}

/** A handled error condition + the system's response (§3.X.3). */
export interface ErrorState {
  condition: string;
  action: string; // what the system does
  response: string; // status code / error payload code
}

/** A functional module's full software requirement (§3.X). */
export interface FunctionalRequirement {
  id: string; // FR-1, FR-2 …
  title: string;
  description: string;
  actor: string; // who/what triggers it
  covers: string[]; // PRD requirement ids (F1…) this implements — traceability
  inputs: IoField[];
  outputs: IoField[];
  workflow: string[]; // step-by-step processing logic (§3.X.2)
  errors: ErrorState[];
}

/** An external/internal software interface (§4.3). */
export interface ApiInterface {
  target: string; // e.g. "Stripe API", "Supabase REST"
  protocol: string; // e.g. "REST/HTTPS", "gRPC"
  purpose: string;
  dataFormat: string; // e.g. "JSON", "Protocol Buffers"
}

/** §5.1 performance — quantified, never vague. */
export interface PerformanceTargets {
  throughput: string;
  latencyP99: string;
  resourceLimit: string;
}

/** §5.2 reliability. */
export interface Reliability {
  uptime: string;
  rpo: string; // recovery point objective
  rto: string; // recovery time objective
}

/** §6.1 a flagged unknown/contradiction needing human resolution (zero-hallucination output). */
export interface OpenIssue {
  ref: string; // TECH-001…
  description: string;
  module: string;
}

/** §6.2 a draft relational entity. */
export interface SchemaEntity {
  name: string;
  fields: string[];
  notes: string;
}

/** What the LLM PROPOSES — the technical functional content. The operating environment,
 *  security posture, and compliance are NOT here: they're derived from the substrate. */
export interface SrsDraft {
  purpose: string; // §1.1
  audience: string; // §1.1
  systemScope: string; // §1.2
  definitions: Definition[]; // §1.3
  systemPerspective: string; // §2.1
  modules: string[]; // §2.2 high-level functions
  designConstraints: string[]; // §2.4 mandated languages/standards/boundaries
  functionalRequirements: FunctionalRequirement[]; // §3
  uiRequirements: string[]; // §4.1 behaviour (WCAG, responsiveness) — not visual style
  apiInterfaces: ApiInterface[]; // §4.3
  performance: PerformanceTargets; // §5.1
  reliability: Reliability; // §5.2
  openIssues: OpenIssue[]; // §6.1
  dataModel: SchemaEntity[]; // §6.2
}

/** §2.3 operating environment — DERIVED from the substrate (a fact, not a guess). */
export interface OperatingEnvironment {
  hardware: string;
  os: string;
  database: string;
  deployment: string;
}

/** §5.3 security & privacy — DERIVED from the substrate + the spec's sensitivity. */
export interface SecurityPosture {
  authentication: string;
  encryptionAtRest: string;
  encryptionInTransit: string;
  dataIsolation: string;
}

/** The assembled SRS: the proposed draft + the PRD (traceability) + the DERIVED env/security. */
export interface Srs extends SrsDraft {
  prd: Prd; // carries the PRD (and its spec) for traceability
  operatingEnvironment: OperatingEnvironment; // §2.3 derived
  security: SecurityPosture; // §5.3 derived
  compliance: string[]; // §2.4 derived applicability (§16-honest — never "compliant")
}

// ── derivations: the deterministic, substrate-true sections (zero hallucination) ──

/** §2.3 — VibeHard runs on a fixed substrate, so the environment is known, not invented. */
export function deriveOperatingEnvironment(spec: Spec): OperatingEnvironment {
  return {
    hardware: "Cloud-managed compute (x86_64 / ARM64) — no bare-metal, device, or IoT constraints.",
    os: "Platform-agnostic — managed serverless (Vercel) or a Linux container (Docker on Fly).",
    database: spec.storesData ? "PostgreSQL 15+ (Supabase-managed), Row-Level Security enforced." : "None — stateless service.",
    deployment: "Vercel (Next.js / Vite / static) OR a single Dockerfile container on Fly.",
  };
}

/** §5.3 — the security posture is a property of the substrate + the data's sensitivity. */
export function deriveSecurityPosture(spec: Spec): SecurityPosture {
  return {
    authentication:
      spec.auth === "none"
        ? "No end-user authentication (public surface); privileged operations still server-side only."
        : `Authenticated sessions (${spec.auth}); short-lived tokens; credentials/secrets in environment, never in source.`,
    encryptionAtRest: spec.storesData ? "AES-256 at rest (Supabase-managed Postgres volume encryption)." : "N/A — no data persisted.",
    encryptionInTransit: "TLS 1.3 enforced for all transport-layer payloads (Supabase + Vercel/Fly).",
    dataIsolation: !spec.storesData
      ? "N/A — stateless."
      : spec.tenancy === "single-user"
        ? "Single-tenant deployment; no shared-infrastructure tenant boundary required."
        : "Per-user isolation via PostgreSQL Row-Level Security (owner-scoped policies), verified by a live anonymous probe before every deploy.",
  };
}

/** §2.4 — compliance APPLICABILITY from the data classification (§16: applicability, never certification). */
export function deriveCompliance(spec: Spec): string[] {
  const s = (spec.sensitiveData ?? []).map((x) => x.toLowerCase());
  const out: string[] = [];
  if (s.some((x) => x.includes("phi") || x.includes("health") || x.includes("medical")))
    out.push("HIPAA may APPLY (handles PHI). VibeHard helps toward safeguards (RLS, encryption, access logging) but does NOT certify compliance.");
  if (s.some((x) => x.includes("pii") || x.includes("personal")))
    out.push("GDPR / CCPA may APPLY (handles PII). Data-subject rights, retention, and deletion remain the operator's responsibility.");
  if (s.some((x) => x.includes("financ") || x.includes("payment") || x.includes("card")))
    out.push("PCI-DSS may APPLY if card data is handled — prefer a tokenizing processor (e.g. Stripe) so card data never touches the app.");
  return out;
}

/** Assemble an SRS from the PRD + the LLM's draft: env/security/compliance are DERIVED. */
export function assembleSrs(prd: Prd, draft: SrsDraft): Srs {
  return {
    ...draft,
    prd,
    operatingEnvironment: deriveOperatingEnvironment(prd.spec),
    security: deriveSecurityPosture(prd.spec),
    compliance: deriveCompliance(prd.spec),
  };
}

/** An empty draft — the degenerate artifact a malformed LLM response coerces to. */
export function emptySrsDraft(): SrsDraft {
  return {
    purpose: "",
    audience: "",
    systemScope: "",
    definitions: [],
    systemPerspective: "",
    modules: [],
    designConstraints: [],
    functionalRequirements: [],
    uiRequirements: [],
    apiInterfaces: [],
    performance: { throughput: "", latencyP99: "", resourceLimit: "" },
    reliability: { uptime: "", rpo: "", rto: "" },
    openIssues: [],
    dataModel: [],
  };
}

const gap = (ruleId: string, severity: Finding["severity"], message: string): Finding => ({ tool: "srs", ruleId, severity, file: "SRS", message });

/** A value is "vague" if it's a quality word with no metric and no explicit deferral — the
 *  deterministic enforcement of directive #1 (no "fast"/"secure"; define exact numbers). */
const VAGUE = /\b(fast|quick(ly)?|secure(ly)?|user-?friendly|scalable|performant|robust|reasonable|good|efficient|snappy|low[- ]latency)\b/i;
function vagueNoMetric(v: string): boolean {
  const t = v.trim();
  if (!t) return false; // emptiness is a separate check
  if (/\btbd\b|n\/a|tech-\d|open issue|see §6/i.test(t)) return false; // explicitly deferred → honest, allowed
  if (/\d/.test(t)) return false; // has a number → it's a metric
  return VAGUE.test(t);
}

/**
 * Deterministic completeness + rigor check on the SRS (the disposer). Blocking (high) when it
 * couldn't feed architecture honestly: a PRD requirement isn't covered by any functional
 * requirement; a functional requirement has no I/O spec or no workflow; a coverage reference is
 * broken; the introduction/scope is empty; the data model is missing for a stateful app; or an
 * NFR is vague/empty instead of a concrete metric (directive #1). Advisory (medium) for a
 * module with no declared error states.
 */
export function reviewSrs(srs: Srs): Finding[] {
  const out: Finding[] = [];

  // §1 introduction present
  if (!srs.purpose.trim()) out.push(gap("no-purpose", "high", "SRS §1.1 has no purpose — the system/module being specified is undefined."));
  if (!srs.systemScope.trim()) out.push(gap("no-system-scope", "high", "SRS §1.2 has no system scope — the boundary against external systems is undefined."));

  // §3 functional coverage of the PRD (every product requirement → a software requirement)
  const covered = new Set(srs.functionalRequirements.flatMap((fr) => fr.covers));
  const uncovered = srs.prd.requirements.filter((r) => !covered.has(r.id)).map((r) => `${r.id} (${r.feature})`);
  if (uncovered.length) out.push(gap("fr-coverage-gap", "high", `These PRD requirements have no functional requirement yet: ${uncovered.join("; ")}.`));

  const reqIds = new Set(srs.prd.requirements.map((r) => r.id));
  const brokenCovers = srs.functionalRequirements.filter((fr) => fr.covers.some((c) => !reqIds.has(c))).map((fr) => fr.id);
  if (brokenCovers.length) out.push(gap("broken-coverage-ref", "high", `These functional requirements reference a PRD requirement id that doesn't exist: ${brokenCovers.join("; ")}.`));

  // §3.X.1/§3.X.2 strict I/O — every module maps inputs/outputs and a workflow (directive #2)
  const noIo = srs.functionalRequirements.filter((fr) => fr.inputs.length === 0 && fr.outputs.length === 0).map((fr) => fr.id || fr.title);
  if (noIo.length) out.push(gap("no-io-spec", "high", `Functional requirements with no input/output specification: ${noIo.join("; ")}.`));
  const noFlow = srs.functionalRequirements.filter((fr) => fr.workflow.length === 0).map((fr) => fr.id || fr.title);
  if (noFlow.length) out.push(gap("no-workflow", "high", `Functional requirements with no step-by-step processing logic: ${noFlow.join("; ")}.`));

  // §5 NFRs must be concrete metrics, not vague terms or empty (directive #1)
  const perf = srs.performance;
  const perfEmpty = !perf.throughput.trim() || !perf.latencyP99.trim() || !perf.resourceLimit.trim();
  if (perfEmpty) out.push(gap("missing-performance-nfr", "high", "SRS §5.1 is incomplete — throughput, p99 latency, and resource limit must each be specified (a number, or an explicit TBD with an open issue)."));
  const vagueFields = [
    ["throughput", perf.throughput],
    ["latencyP99", perf.latencyP99],
    ["resourceLimit", perf.resourceLimit],
    ["uptime", srs.reliability.uptime],
  ].filter(([, v]) => vagueNoMetric(v!)).map(([k]) => k);
  if (vagueFields.length) out.push(gap("vague-nfr", "high", `These NFRs use a vague term instead of a concrete metric (directive: define exact values): ${vagueFields.join(", ")}.`));

  // §6.2 data model present for a stateful app
  if (srs.prd.spec.storesData && srs.dataModel.length === 0) out.push(gap("no-data-model", "high", "Stateful app, but SRS §6.2 drafts no data model (entities + fields)."));

  // §3.X.3 error states — advisory (some read paths legitimately have few)
  const noErrors = srs.functionalRequirements.filter((fr) => fr.errors.length === 0).map((fr) => fr.id || fr.title);
  if (noErrors.length) out.push(gap("no-error-states", "medium", `Functional requirements with no declared error states (verify the happy path is truly the only path): ${noErrors.join("; ")}.`));

  return out;
}

/** Gate-style verdict for the SRS readiness check (block iff a blocking gap). */
export function srsReviewVerdict(srs: Srs, ranAt: string = new Date().toISOString()): GateVerdict {
  return verdictOf("srs", reviewSrs(srs), ranAt);
}

// ── trust boundary: coerce the LLM's JSON, never trust the model's shape (§11) ──
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : []);

function coerceIoFields(raw: unknown): IoField[] {
  if (!Array.isArray(raw)) return [];
  const out: IoField[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const element = str(o.element);
    if (!element) continue;
    out.push({ element, type: str(o.type), constraints: str(o.constraints), source: str(o.source) });
  }
  return out;
}

function coerceErrors(raw: unknown): ErrorState[] {
  if (!Array.isArray(raw)) return [];
  const out: ErrorState[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const condition = str(o.condition);
    if (!condition) continue;
    out.push({ condition, action: str(o.action), response: str(o.response) });
  }
  return out;
}

function coerceFunctionalRequirements(raw: unknown): FunctionalRequirement[] {
  if (!Array.isArray(raw)) return [];
  const out: FunctionalRequirement[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const title = str(o.title);
    const description = str(o.description);
    if (!title && !description) continue;
    out.push({
      id: str(o.id) || `FR-${out.length + 1}`,
      title,
      description,
      actor: str(o.actor),
      covers: strArr(o.covers),
      inputs: coerceIoFields(o.inputs),
      outputs: coerceIoFields(o.outputs),
      workflow: strArr(o.workflow),
      errors: coerceErrors(o.errors),
    });
  }
  return out;
}

function coerceDefinitions(raw: unknown): Definition[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map((o) => ({ term: str(o.term), definition: str(o.definition) }))
    .filter((d) => d.term);
}

function coerceApis(raw: unknown): ApiInterface[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map((o) => ({ target: str(o.target), protocol: str(o.protocol), purpose: str(o.purpose), dataFormat: str(o.dataFormat) }))
    .filter((a) => a.target);
}

function coerceOpenIssues(raw: unknown): OpenIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: OpenIssue[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const description = str(o.description);
    if (!description) continue;
    out.push({ ref: str(o.ref) || `TECH-${String(out.length + 1).padStart(3, "0")}`, description, module: str(o.module) });
  }
  return out;
}

function coerceSchema(raw: unknown): SchemaEntity[] {
  if (!Array.isArray(raw)) return [];
  const out: SchemaEntity[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const name = str(o.name);
    if (!name) continue;
    out.push({ name, fields: strArr(o.fields), notes: str(o.notes) });
  }
  return out;
}

function coercePerf(raw: unknown): PerformanceTargets {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { throughput: str(o.throughput), latencyP99: str(o.latencyP99), resourceLimit: str(o.resourceLimit) };
}

function coerceReliability(raw: unknown): Reliability {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { uptime: str(o.uptime), rpo: str(o.rpo), rto: str(o.rto) };
}

/** The top-level trust boundary: coerce the LLM's full SRS JSON into a valid SrsDraft. */
export function coerceSrsDraft(raw: unknown): SrsDraft {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    purpose: str(o.purpose),
    audience: str(o.audience),
    systemScope: str(o.systemScope),
    definitions: coerceDefinitions(o.definitions),
    systemPerspective: str(o.systemPerspective),
    modules: strArr(o.modules),
    designConstraints: strArr(o.designConstraints),
    functionalRequirements: coerceFunctionalRequirements(o.functionalRequirements),
    uiRequirements: strArr(o.uiRequirements),
    apiInterfaces: coerceApis(o.apiInterfaces),
    performance: coercePerf(o.performance),
    reliability: coerceReliability(o.reliability),
    openIssues: coerceOpenIssues(o.openIssues),
    dataModel: coerceSchema(o.dataModel),
  };
}

// ── rendering: the human-readable SRS document (the engineer/reviewer deliverable) ──

/** Render the SRS as a Markdown document following the template. Written alongside the build. */
export function renderSrsMarkdown(srs: Srs): string {
  const L: string[] = [];
  const h = (s: string) => L.push(`\n## ${s}\n`);
  const sub = (s: string) => L.push(`\n### ${s}\n`);

  L.push(`# Software Requirements Specification — ${srs.prd.spec.name}`);
  L.push(`\n**Author:** VibeHard (AI · Principal Systems Architect) · **Status:** In Review · **Traces to:** PRD for ${srs.prd.spec.name}`);

  h("1. Introduction");
  sub("1.1 Purpose");
  L.push(srs.purpose || "_—_");
  if (srs.audience) L.push(`\n**Audience:** ${srs.audience}`);
  sub("1.2 System Scope");
  L.push(srs.systemScope || "_—_");
  if (srs.definitions.length) {
    sub("1.3 Definitions, Acronyms, and Abbreviations");
    L.push("| Term | Definition |", "|------|------------|");
    for (const d of srs.definitions) L.push(`| ${d.term} | ${d.definition} |`);
  }

  h("2. Overall Description");
  sub("2.1 System Perspective");
  L.push(srs.systemPerspective || "_—_");
  sub("2.2 System Functions");
  for (const m of srs.modules) L.push(`- ${m}`);
  sub("2.3 Operating Environment (derived from the platform)");
  L.push(`- **Hardware:** ${srs.operatingEnvironment.hardware}`);
  L.push(`- **OS:** ${srs.operatingEnvironment.os}`);
  L.push(`- **Database:** ${srs.operatingEnvironment.database}`);
  L.push(`- **Deployment:** ${srs.operatingEnvironment.deployment}`);
  sub("2.4 Design & Implementation Constraints");
  for (const c of srs.designConstraints) L.push(`- ${c}`);
  for (const c of srs.compliance) L.push(`- **Compliance:** ${c}`);

  h("3. Specific Functional Requirements");
  for (const fr of srs.functionalRequirements) {
    sub(`${fr.id} ${fr.title}`);
    L.push(`**Description:** ${fr.description}`);
    L.push(`**Actor:** ${fr.actor || "—"} · **Implements:** ${fr.covers.join(", ") || "—"}`);
    if (fr.inputs.length || fr.outputs.length) {
      L.push(`\n_Inputs / Outputs:_`);
      L.push("| Dir | Data Element | Type | Constraints / Validation | Source |", "|-----|--------------|------|--------------------------|--------|");
      for (const i of fr.inputs) L.push(`| in | ${i.element} | ${i.type} | ${i.constraints} | ${i.source} |`);
      for (const o of fr.outputs) L.push(`| out | ${o.element} | ${o.type} | ${o.constraints} | ${o.source} |`);
    }
    if (fr.workflow.length) {
      L.push(`\n_Processing Logic:_`);
      fr.workflow.forEach((s, i) => L.push(`${i + 1}. ${s}`));
    }
    if (fr.errors.length) {
      L.push(`\n_Error States:_`);
      for (const e of fr.errors) L.push(`- **${e.condition}** → ${e.action} → \`${e.response}\``);
    }
  }

  h("4. External Interface Requirements");
  if (srs.uiRequirements.length) {
    sub("4.1 User Interfaces (behaviour)");
    for (const u of srs.uiRequirements) L.push(`- ${u}`);
  }
  sub("4.3 Software & API Interfaces");
  if (srs.apiInterfaces.length) {
    L.push("| Target | Protocol | Purpose | Data Format |", "|--------|----------|---------|-------------|");
    for (const a of srs.apiInterfaces) L.push(`| ${a.target} | ${a.protocol} | ${a.purpose} | ${a.dataFormat} |`);
  } else L.push("_None beyond the platform substrate._");

  h("5. Non-Functional Requirements");
  sub("5.1 Performance");
  L.push(`- **Throughput:** ${srs.performance.throughput}`);
  L.push(`- **Latency (p99):** ${srs.performance.latencyP99}`);
  L.push(`- **Resource utilization:** ${srs.performance.resourceLimit}`);
  sub("5.2 Reliability & Availability");
  L.push(`- **Uptime:** ${srs.reliability.uptime || "—"}`);
  L.push(`- **RPO / RTO:** ${srs.reliability.rpo || "—"} / ${srs.reliability.rto || "—"}`);
  sub("5.3 Security & Privacy (derived from the platform)");
  L.push(`- **Authentication:** ${srs.security.authentication}`);
  L.push(`- **Encryption at rest:** ${srs.security.encryptionAtRest}`);
  L.push(`- **Encryption in transit:** ${srs.security.encryptionInTransit}`);
  L.push(`- **Data isolation:** ${srs.security.dataIsolation}`);

  h("6. Open Technical Issues & Appendices");
  sub("6.1 Open Issues / Technical Unknowns");
  if (srs.openIssues.length) {
    L.push("| Ref | Description | Impacted Module |", "|-----|-------------|-----------------|");
    for (const i of srs.openIssues) L.push(`| ${i.ref} | ${i.description} | ${i.module} |`);
  } else L.push("_None flagged._");
  if (srs.dataModel.length) {
    sub("6.2 Data Model / Schema Draft");
    for (const e of srs.dataModel) L.push(`- **${e.name}** (${e.fields.join(", ")})${e.notes ? ` — ${e.notes}` : ""}`);
  }

  return L.join("\n");
}
