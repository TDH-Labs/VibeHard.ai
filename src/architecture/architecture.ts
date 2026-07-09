/**
 * The Architecture — stage 4 of the front-half: the SRS (and PRD) turned into a Software
 * Architecture Document (SAD) the codegen builds from. It still names the stack and the
 * WORKSTREAMS (components — each owns files + a dependency graph), but now also carries the
 * SAD's decisions: system overview + goals, the architectural pattern + rationale + trade-offs,
 * data flow, and a data-architecture (storage rationale + schema DDL + state management). Each
 * workstream records which SRS functional requirements it implements (`covers`) — that's the
 * §6 traceability matrix.
 *
 * An LLM (a Software Architect) proposes it (architect.ts); this module is the deterministic
 * disposer:
 *   • `reviewArchitecture` — validate the graph (no cycles / dangling deps / file-less
 *     workstreams), the substrate-fit, the SAD headline decisions, AND traceability (every SRS
 *     functional requirement maps to a component) before anything is generated;
 *   • `buildOrder` — topologically sort the workstreams into parallel-eligible TIERS;
 *   • the §5 security/infra + §4 storage facts are DERIVED from the substrate (§11), reusing the
 *     SRS derivations so the SAD and the SRS agree by construction.
 */
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";
import type { Prd } from "../prd/index.ts";
import { deriveOperatingEnvironment, deriveSecurityPosture, type Srs } from "../srs/index.ts";

/** One component of the app — owns files, may depend on other workstreams, implements SRS FRs. */
export interface Workstream {
  name: string;
  responsibility: string;
  files: string[]; // the files this workstream generates (its slice of the package)
  dependsOn: string[]; // names of workstreams that must be built first
  covers: string[]; // SRS functional requirement ids (FR-1…) this component implements — §6 traceability
}

/** §2 — the chosen architectural pattern and the engineering reasoning behind it. */
export interface ArchPattern {
  name: string; // e.g. "Serverless modular monolith", "Event-driven microservices"
  rationale: string; // WHY this pattern, from the SRS constraints
  tradeoffs: string; // what is being sacrificed
}

/** §4 — the data architecture beyond the bare storage engine. */
export interface DataArchitecture {
  storageRationale: string; // why this engine (constrained to Supabase/Postgres)
  schema: string; // initial relational schema (SQL DDL) for core entities
  stateManagement: string; // how data is written, cached, synced
}

export interface Architecture {
  prd: Prd; // source, for traceability
  srs?: Srs; // the SRS this design satisfies (present when the SRS stage ran) — drives §6 traceability
  stack: string; // e.g. "Next.js + Supabase + TypeScript + Tailwind"
  workstreams: Workstream[];
  // ── SAD sections (LLM-proposed) ──
  systemOverview: string; // §1 high-level description
  architecturalGoals: string[]; // §1 guiding principles (e.g. fail-closed security, tenant isolation)
  pattern: ArchPattern; // §2
  dataFlow: string; // §3 how components communicate (REST / Pub-Sub / IPC …)
  dataArchitecture: DataArchitecture; // §4
  /** Structured data model for the DETERMINISTIC backend generator (src/backend). Raw LLM JSON —
   *  validated by coerceDataModel at use. Optional/additive: absent on older artifacts; when present
   *  + the deterministic-backend path is on, it generates migrations/RLS/auth/clients instead of the
   *  LLM writing them. */
  dataModel?: unknown;
}

const asStr = (v: unknown, d = ""): string => (typeof v === "string" ? v.trim() : d);
const asStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim()) : [];

function coercePattern(raw: unknown): ArchPattern {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { name: asStr(o.name), rationale: asStr(o.rationale), tradeoffs: asStr(o.tradeoffs) };
}
function coerceDataArchitecture(raw: unknown): DataArchitecture {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { storageRationale: asStr(o.storageRationale), schema: asStr(o.schema), stateManagement: asStr(o.stateManagement) };
}

/** Trust boundary: coerce the LLM's SAD JSON into a valid Architecture; carry prd + srs. */
export function coerceArchitecture(raw: unknown, prd: Prd, srs?: Srs): Architecture {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const workstreams = (Array.isArray(o.workstreams) ? o.workstreams : [])
    .map((w): Workstream | null => {
      if (!w || typeof w !== "object") return null;
      const wo = w as Record<string, unknown>;
      const name = asStr(wo.name);
      if (!name) return null;
      return { name, responsibility: asStr(wo.responsibility), files: asStrArr(wo.files), dependsOn: asStrArr(wo.dependsOn), covers: asStrArr(wo.covers) };
    })
    .filter((w): w is Workstream => w !== null);
  return {
    prd,
    srs,
    stack: asStr(o.stack, "unspecified"),
    workstreams,
    systemOverview: asStr(o.systemOverview),
    architecturalGoals: asStrArr(o.architecturalGoals),
    pattern: coercePattern(o.pattern),
    dataFlow: asStr(o.dataFlow),
    dataArchitecture: coerceDataArchitecture(o.dataArchitecture),
    dataModel: o.dataModel, // raw; coerceDataModel (src/backend) validates at the generation site
  };
}

/**
 * Pure: topologically sort workstreams into build tiers (Kahn's algorithm). Tier N
 * contains every workstream whose dependencies are all in tiers < N. A cycle leaves
 * workstreams unordered — `buildOrder` stops, and `reviewArchitecture` reports it.
 * Unknown dependencies are ignored here (also reported separately) so one bad edge
 * doesn't wedge the whole order.
 */
export function buildOrder(arch: Architecture): Workstream[][] {
  const byName = new Map(arch.workstreams.map((w) => [w.name, w]));
  const remaining = new Set(byName.keys());
  const done = new Set<string>();
  const tiers: Workstream[][] = [];

  while (remaining.size) {
    const ready = [...remaining].filter((n) => byName.get(n)!.dependsOn.every((d) => done.has(d) || !byName.has(d)));
    if (ready.length === 0) break; // no progress possible → cycle among the rest
    ready.sort(); // deterministic order within a tier
    for (const n of ready) {
      remaining.delete(n);
      done.add(n);
    }
    tiers.push(ready.map((n) => byName.get(n)!));
  }
  return tiers;
}

const gap = (ruleId: string, severity: Finding["severity"], message: string): Finding => ({
  tool: "architecture",
  ruleId,
  severity,
  file: "ARCHITECTURE",
  message,
});

// ── Substrate-fit (architect-steering) ──────────────────────────────────────────
// VibeHard deploys on Supabase (the data layer the gate verifies RLS on, LIVE) + a
// Vercel app or a single Dockerfile container (Fly). The architect must pick a stack
// the platform can actually ship AND verify; these flag an off-substrate stack so the
// existing architect retry loop re-proposes — a build can never reach codegen with an
// unshippable stack (the "Express + pg + React" problem that bit a prior build).
const SUPABASE_RE = /\bsupabase\b/i;
const INCOMPATIBLE_BACKEND_RE = /\b(mongo(?:db)?|firebase|firestore|dynamo(?:db)?|planetscale|cockroach(?:db)?|fauna(?:db)?|mysql|mariadb|sqlite|neon)\b/i;
const RAW_DB_CLIENT_RE = /\b(pg|node-postgres|prisma|typeorm|sequelize|knex|drizzle)\b/i;

/** A stack that names a hosting platform or a cloud/hosted DB — wrong for a downloadable-tool,
 *  which never gets a URL and runs entirely on the user's own machine. */
const HOSTED_SIGNAL_RE = /\b(supabase|vercel|firebase|dockerfile|fly\.io)\b/i;

/** Deterministic architect-steering: the stack must be deployable on the substrate
 *  (Supabase data layer + Vercel/Fly host) — UNLESS the spec declared deployTarget
 *  "downloadable-tool", which has no substrate to fit at all (no hosting, no cloud DB).
 *  Off-substrate → blocking gaps the loop fixes. */
export function assessSubstrateFit(arch: Architecture): Finding[] {
  const out: Finding[] = [];
  const stack = arch.stack || "";
  const isDownloadable = arch.prd?.spec?.deployTarget === "downloadable-tool";

  if (isDownloadable) {
    // The inverse check: this is a declared local tool, so a stack that names ANY hosting
    // platform or cloud DB is the architect ignoring deployTarget (observed live, 2026-07-09 —
    // the LLM proposed Supabase + a Dockerfile for a single-user local TUI tool despite the
    // system prompt's relaxed instruction). Force it to re-propose rather than silently letting
    // a cloud-shaped design through for a tool that was never supposed to have one.
    const hosted = stack.match(HOSTED_SIGNAL_RE);
    if (hosted) {
      out.push(
        gap(
          "downloadable-tool-uses-hosted-stack",
          "high",
          `This is a declared downloadable tool (deployTarget: "downloadable-tool") — it never gets a hosted URL — but its stack names "${hosted[0]}", which only makes sense for a hosted app. Use local storage instead (SQLite, or plain local JSON/file-based storage), and no deploy artifact (no Dockerfile, no hosting platform).`,
        ),
      );
    }
    return out; // no substrate to fit — the checks below are all about being deployable, which doesn't apply
  }

  const incompatible = stack.match(INCOMPATIBLE_BACKEND_RE);
  if (incompatible) {
    out.push(
      gap(
        "stack-incompatible-backend",
        "high",
        `Stack names "${incompatible[0]}", which VibeHard can't provision or verify RLS on. The data layer must be Supabase (Postgres + Row-Level Security).`,
      ),
    );
  }
  const hasSupabase = SUPABASE_RE.test(stack);
  const storesData = Boolean(arch.prd?.spec?.storesData);
  if (storesData && !hasSupabase && !incompatible) {
    const rawDb = stack.match(RAW_DB_CLIENT_RE);
    const why = rawDb ? `uses "${rawDb[0]}" against a self-managed database` : "doesn't use Supabase";
    out.push(
      gap(
        "stack-not-supabase",
        "high",
        `This app stores data but its stack ${why}. Use Supabase as the data layer so the security gate can verify tenant isolation (RLS) live before deploy.`,
      ),
    );
  }
  return out;
}

/** Deterministic validation: the design must be a complete, traceable, buildable SAD before codegen. */
export function reviewArchitecture(arch: Architecture): Finding[] {
  const out: Finding[] = [];
  if (arch.workstreams.length === 0) {
    out.push(gap("no-workstreams", "high", "The architecture defines no workstreams — there's nothing to build from."));
    return out;
  }

  // graph integrity
  const names = new Set(arch.workstreams.map((w) => w.name));
  for (const w of arch.workstreams) {
    if (w.files.length === 0) out.push(gap("workstream-no-files", "high", `Workstream "${w.name}" owns no files — it can't produce anything.`));
    for (const d of w.dependsOn) {
      if (!names.has(d)) out.push(gap("unknown-dependency", "high", `Workstream "${w.name}" depends on "${d}", which isn't a workstream.`));
    }
  }
  const ordered = buildOrder(arch).reduce((n, tier) => n + tier.length, 0);
  if (ordered < arch.workstreams.length) {
    out.push(gap("dependency-cycle", "high", "The workstream dependency graph has a cycle — it can't be built in a valid order."));
  }

  // File ownership must be DISJOINT. Same-tier workstreams are built concurrently (parallel codegen),
  // so two claiming the same path race to a non-deterministic last-writer-wins — and ambiguous
  // ownership is an architecture smell regardless of tier. Flag it so the architect re-proposes.
  const owners = new Map<string, string[]>();
  for (const w of arch.workstreams) {
    for (const f of w.files) (owners.get(f) ?? owners.set(f, []).get(f)!).push(w.name);
  }
  for (const [file, claimants] of owners) {
    if (claimants.length > 1) out.push(gap("file-collision", "high", `File "${file}" is claimed by multiple workstreams (${claimants.join(", ")}) — ownership must be disjoint so the concurrent build is deterministic.`));
  }

  // SAD headline decisions must be present (a hollow SAD can't guide a build or a reviewer)
  if (!arch.systemOverview.trim()) out.push(gap("no-system-overview", "high", "The SAD has no system overview (§1)."));
  if (!arch.pattern.name.trim()) out.push(gap("no-pattern", "high", "The SAD names no architectural pattern (§2)."));
  if (!arch.pattern.rationale.trim()) out.push(gap("no-pattern-rationale", "high", "The SAD's pattern has no rationale (§2) — why this design was chosen must be stated."));

  // §6 traceability: every SRS functional requirement must map to a component (only when the SRS ran)
  if (arch.srs) {
    const frIds = new Set(arch.srs.functionalRequirements.map((f) => f.id));
    const covered = new Set(arch.workstreams.flatMap((w) => w.covers));
    const uncovered = [...frIds].filter((id) => !covered.has(id));
    if (uncovered.length) {
      out.push(gap("component-coverage-gap", "high", `These SRS functional requirements map to no component: ${uncovered.join("; ")}.`));
    }
    const broken = arch.workstreams.filter((w) => w.covers.some((c) => !frIds.has(c))).map((w) => w.name);
    if (broken.length) {
      out.push(gap("broken-fr-ref", "high", `These workstreams claim to implement an SRS requirement that doesn't exist: ${broken.join("; ")}.`));
    }
  }

  out.push(...assessSubstrateFit(arch)); // architect-steering: keep the stack on-substrate (Supabase + Vercel/Fly)
  return out;
}

/** Gate-style verdict for architecture readiness (block iff a blocking gap). */
export function architectureVerdict(arch: Architecture, ranAt: string = new Date().toISOString()): GateVerdict {
  return verdictOf("architecture", reviewArchitecture(arch), ranAt);
}

// ── rendering: the Software Architecture Document (the engineer/reviewer deliverable) ──

/** Render the architecture as a Software Architecture Document (the §1–§6 template). The §5
 *  security/infra + §4 storage facts are DERIVED from the substrate (reusing the SRS
 *  derivations) so the SAD and the SRS agree by construction. */
export function renderSadMarkdown(arch: Architecture): string {
  const spec = arch.prd.spec;
  const env = deriveOperatingEnvironment(spec);
  const sec = deriveSecurityPosture(spec);
  const tiers = buildOrder(arch);
  const L: string[] = [];
  const h = (s: string) => L.push(`\n## ${s}\n`);

  L.push(`# Software Architecture Document (SAD): ${spec.name}`);

  h("1. Executive Summary & System Context");
  L.push(`**System Overview:** ${arch.systemOverview || "—"}`);
  L.push(`\n**Upstream Lineage:** satisfies the SRS${arch.srs ? "" : " (not run)"} → PRD (${arch.prd.title || spec.name}) → Spec (${spec.name}). Status: In Review.`);
  if (arch.architecturalGoals.length) {
    L.push(`\n**Architectural Goals & Constraints:**`);
    for (const g of arch.architecturalGoals) L.push(`- ${g}`);
  }

  h("2. Architectural Patterns & Decisions");
  L.push(`**Pattern Selection:** ${arch.pattern.name || "—"}`);
  L.push(`\n**Rationale:** ${arch.pattern.rationale || "—"}`);
  L.push(`\n**Trade-offs:** ${arch.pattern.tradeoffs || "—"}`);

  h("3. Component & Services Decomposition");
  L.push(`**Stack:** ${arch.stack}`);
  L.push(`\n**Build tiers (parallel-eligible within a tier):** ${tiers.map((t) => t.map((w) => w.name).join(" + ")).join(" → ") || "—"}`);
  L.push(`\n**Core Components:**`);
  L.push("| Component | Responsibility | Depends on | Files |", "|-----------|----------------|------------|-------|");
  for (const w of arch.workstreams) L.push(`| ${w.name} | ${w.responsibility} | ${w.dependsOn.join(", ") || "—"} | ${w.files.join(", ")} |`);
  L.push(`\n**Data Flow & Communication:** ${arch.dataFlow || "—"}`);

  h("4. Data Architecture & Schema Design");
  L.push(`**Storage Engine:** ${env.database}`);
  if (arch.dataArchitecture.storageRationale) L.push(`\n**Rationale:** ${arch.dataArchitecture.storageRationale}`);
  L.push(`\n**State Management & Persistence:** ${arch.dataArchitecture.stateManagement || "—"}`);
  if (arch.dataArchitecture.schema.trim()) {
    L.push(`\n**Data Models & Schema (DDL draft):**`);
    L.push("```sql", arch.dataArchitecture.schema.trim(), "```");
  }

  h("5. Security, Privacy, & Infrastructure");
  L.push(`**Authentication:** ${sec.authentication}`);
  L.push(`\n**Authorization & Data Isolation:** ${sec.dataIsolation}`);
  L.push(`\n**Data Protection:** At rest — ${sec.encryptionAtRest} In transit — ${sec.encryptionInTransit}`);
  L.push(`\n**Deployment Topology:** ${env.deployment} ${env.os}`);

  h("6. Verification & Traceability Matrix");
  if (arch.srs) {
    L.push("| SRS Requirement | Implemented by |", "|-----------------|----------------|");
    for (const fr of arch.srs.functionalRequirements) {
      const impl = arch.workstreams.filter((w) => w.covers.includes(fr.id)).map((w) => w.name);
      L.push(`| ${fr.id} ${fr.title} | ${impl.join(", ") || "**UNMAPPED**"} |`);
    }
  } else {
    L.push("_SRS not available — component-to-requirement mapping by workstream responsibility._");
  }

  return L.join("\n");
}
