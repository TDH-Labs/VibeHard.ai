/**
 * The PRD — the front-half's durable, schema-validated spec (PROJECT_BRIEF.md §22,
 * §15 "scoped + architected"). The product story is "scoped, architected, secure,
 * verified": this is the *scoped* half. An LLM DRAFTS a PRD from the operator's
 * prompt (the proposing seam — next increment); this module is the DISPOSING half:
 *
 *   • `reviewSpec` — a deterministic spec-readiness check (the "grill"). It returns
 *     the SAME `Finding` shape the gates emit, so a PRD gap flows through the same
 *     translation + escalation machinery, and a *blocking* gap stops codegen exactly
 *     like a gate stops a deploy. Crucially it PREDICTS the back-half: a multi-tenant
 *     sensitive-data spec is told up front "you'll need tenant-scoped RLS" — which
 *     is what the `rls` gate later enforces. Catch it at the spec, not after codegen.
 *   • `decideRigor` — §16 adaptive rigor: prototype (skip ceremony) vs production
 *     (full PRD/architecture/verify/refactor), decided deterministically from the
 *     spec's own signals.
 *
 * §16 BINDING: nothing here claims compliance/certification — gaps are framed as
 * "helps toward," never "makes you compliant."
 */
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";

export type SensitiveClass = "none" | "pii" | "phi" | "financial" | "credentials";
/** How many distinct owners share the app's data — drives the isolation expectation. */
export type Tenancy = "single-user" | "single-tenant" | "multi-tenant";
/** Where the built app is meant to run — a live hosted URL, or code the user downloads and
 *  runs on their own machine. Drives the `verify` gate's check and whether the build is downloadable. */
export type DeployTarget = "hosted-app" | "downloadable-tool";
export type Rigor = "prototype" | "production";

export interface DataEntity {
  name: string;
  fields: string[];
  /** does this entity hold sensitive data (PII/PHI/financial/credentials)? */
  sensitive: boolean;
}

/** One post-build change request, folded back into the spec (backlog #2 iterate/refine).
 *  The trail keeps the spec describing what the app actually became. */
export interface Refinement {
  at: string; // ISO timestamp the refine was accepted
  change: string; // the user's plain-language change request
}

/** The structured spec the front-half produces and the back-half builds against. */
export interface Spec {
  name: string;
  summary: string;
  features: string[];
  users: string; // who uses it, in plain words
  tenancy: Tenancy;
  deployTarget: DeployTarget; // drives the verify gate's boot check and whether the build is downloadable
  auth: string; // "none" | "email-password" | "oauth" | "sso" | …
  storesData: boolean; // does the app persist data at all?
  /** true iff ALL persisted data lives client-side only (localStorage/IndexedDB) — no server,
   *  no database, no accounts needed to see it again. Optional (not required) so existing
   *  hand-built Spec fixtures keep compiling; coerceSpec always fills it with a default.
   *  THE BUG THIS CLOSES (found live 2026-07-11): with no way to say "no backend needed," the
   *  architect defaulted to Supabase for every hosted-app spec that stores ANY data, even ones
   *  whose own summary explicitly said "client-side only" — which then generated a real Supabase
   *  backend (service-role key + all) for an app that was never supposed to have one. */
  clientOnlyStorage?: boolean;
  dataEntities: DataEntity[];
  sensitiveData: SensitiveClass[]; // data classification (§21 control 1)
  realUsers: boolean; // rigor signal — not a throwaway
  maintained: boolean; // rigor signal — lives over time
  refinements?: Refinement[]; // post-build change trail (iterate/refine); absent on fresh specs
}

/** True if the spec involves sensitive data, by classification OR a flagged entity. */
export function isSensitive(spec: Spec): boolean {
  return spec.sensitiveData.some((c) => c !== "none") || spec.dataEntities.some((e) => e.sensitive);
}

const gap = (ruleId: string, severity: Finding["severity"], field: string, message: string): Finding => ({
  tool: "spec",
  ruleId,
  severity,
  file: field, // the PRD field the gap is in (no file/line — this is a spec, not code)
  message,
});

/** Strong, unambiguous phrasing for "this data never leaves the device" — deliberately narrow
 *  (not just the word "local") to keep false positives rare; matched against the model's own
 *  free-text summary/features, which is the SAME text a human reviewer would read to reach the
 *  same conclusion. */
const CLIENT_ONLY_SIGNAL_RE = /\b(local-only|locally[- ]only|localstorage|indexeddb|client-side only|no backend|no server(?:-side)?|only in the browser)\b/i;

/**
 * Pure: a deterministic spec-readiness check. High/critical = BLOCKING (don't build
 * an underspecified spec); medium/low = ADVISORY (surface, don't block). Mirrors the
 * gate disposition so the front-half is a quality bar, not just an LLM prompt.
 */
export function reviewSpec(spec: Spec): Finding[] {
  const out: Finding[] = [];
  const sensitive = isSensitive(spec);

  // Nothing to build.
  if (spec.features.length === 0) {
    out.push(gap("no-features", "high", "features", "No features are defined — there's nothing concrete to build yet."));
  }

  // Stores data but no model → you can't safely build the schema (and the rls gate
  // would have nothing coherent to check).
  if (spec.storesData && spec.dataEntities.length === 0) {
    out.push(gap("no-data-model", "high", "dataEntities", "The app stores data but no data model (entities/fields) is defined."));
  }

  // THE BUG THIS CLOSES (found live 2026-07-12): the model's own summary can clearly describe
  // client-only persistence ("local-only persistence via localStorage") while the
  // clientOnlyStorage flag itself stays unset — an LLM-JSON-field reliability gap, not a genuine
  // judgment call (an adversarial review elsewhere in the pipeline reaches the identical
  // conclusion from the same text). Left uncaught, architecture silently defaults to a real
  // backend because the flag its "no backend needed" branch depends on was never set. That
  // downstream check is deliberately advisory-only for LLM opinions (an LLM finding never
  // blocks); THIS is the deterministic equivalent, so it blocks and forces intake to reconcile
  // the flag with what it already wrote, the same way the no-data-model check above does.
  const clientOnlySignal = spec.storesData && !spec.clientOnlyStorage ? `${spec.summary} ${spec.features.join(" ")}`.match(CLIENT_ONLY_SIGNAL_RE) : null;
  if (clientOnlySignal) {
    out.push(
      gap(
        "client-only-storage-mismatch",
        "high",
        "clientOnlyStorage",
        `The spec's own description says data stays local/client-side (it says "${clientOnlySignal[0]}"), but clientOnlyStorage isn't set true — architecture will default to a real backend unless this is corrected. If this really has no backend, set clientOnlyStorage true; if it actually needs to sync across devices or users, rewrite the summary/features to say so instead.`,
      ),
    );
  }

  // Sensitive or multi-tenant with no auth = open to anyone. The CVE-class mistake,
  // caught at the spec.
  if ((sensitive || spec.tenancy === "multi-tenant") && spec.auth === "none") {
    out.push(
      gap("no-auth-for-sensitive", "critical", "auth", "Sensitive or multi-tenant data with no authentication — anyone could reach it. Define how users sign in before building."),
    );
  }

  // PREDICT the rls gate: multi-tenant + sensitive → tenant-scoped row-level
  // isolation will be required. ADVISORY, not blocking — the spec is buildable; this
  // is a heads-up to carry into the architecture/codegen plan, and the rls gate
  // ENFORCES it after codegen (front-half advises, back-half disposes).
  if (spec.tenancy === "multi-tenant" && sensitive) {
    out.push(
      gap(
        "tenant-isolation-required",
        "medium",
        "tenancy",
        "Multiple tenants share sensitive data — this WILL need row-level isolation (RLS scoped to each tenant). Plan the per-tenant access model now; the rls gate enforces it after codegen.",
      ),
    );
  }

  // §21 control 2 (advisory): sensitive data needs a retention + deletion story.
  if (sensitive && !/\b(retention|delet|purge|erasure|expire|ttl)\w*/i.test(`${spec.summary} ${spec.features.join(" ")}`)) {
    out.push(
      gap("no-retention-plan", "medium", "sensitiveData", "Sensitive data with no stated retention or deletion plan — note how long it's kept and how it's removed (helps toward compliance; it never certifies it)."),
    );
  }

  // Consistency: an entity is flagged sensitive but the classification is empty.
  if (spec.dataEntities.some((e) => e.sensitive) && !spec.sensitiveData.some((c) => c !== "none")) {
    out.push(
      gap("sensitive-classification-gap", "low", "sensitiveData", "A data entity is marked sensitive but the data classification is empty — classify it (PII / PHI / financial)."),
    );
  }

  return out;
}

/** Wrap the readiness check as a gate-style verdict (block iff a blocking gap). */
export function specVerdict(spec: Spec, ranAt: string = new Date().toISOString()): GateVerdict {
  return verdictOf("spec", reviewSpec(spec), ranAt);
}

/**
 * Pure: §16 adaptive rigor. Production rigor (full PRD/architecture/verify/refactor)
 * when the spec serves real users, is maintained over time, OR touches sensitive
 * data; otherwise prototype rigor (skip the ceremony — a throwaway doesn't need a PRD).
 */
export function decideRigor(spec: Spec): Rigor {
  return spec.realUsers || spec.maintained || isSensitive(spec) ? "production" : "prototype";
}
