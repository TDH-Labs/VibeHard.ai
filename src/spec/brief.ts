/**
 * PRD → generation brief (PROJECT_BRIEF.md §22, §15). This is where the front-half
 * PAYS OFF: the grilled spec's security posture is turned into EXPLICIT codegen
 * instructions, so the model builds the protections in from the start instead of
 * relying on its defaults. Each requirement directly pre-empts a back-half gate
 * finding — RLS scoping pre-empts `rls-policy-using-true` / `rls-policy-authenticated`
 * / `rls-disabled`; parameterized queries pre-empt the SQLi `sast` finding; secrets
 * in env pre-empt `secrets`. Better spec in → fewer blocks out → less escalation.
 *
 * §16 BINDING: the brief asks for technical controls; it never claims compliance.
 * Pure — a function of the PRD only.
 */
import { isSensitive, type Spec } from "./spec.ts";

/** The security instructions implied by the spec — each maps to a gate it pre-empts. */
export function securityRequirements(spec: Spec): string[] {
  const reqs: string[] = [];
  const sensitive = isSensitive(spec);
  // A purely static, no-data, no-auth app needs none of this.
  if (!(spec.storesData || spec.auth !== "none" || sensitive)) return reqs;

  if (sensitive || spec.tenancy === "multi-tenant") {
    reqs.push("Require authentication on every route that reads or writes data; never expose data on an unauthenticated endpoint.");
  }
  if (sensitive && spec.storesData) {
    reqs.push("Add a migration that ENABLES Row-Level Security on every table holding sensitive data AND defines access policies (RLS on with no policy is not enough).");
    reqs.push(
      spec.tenancy === "multi-tenant"
        ? "Scope every RLS policy to the owning user/tenant — e.g. `using (auth.uid() = user_id)` or a tenant-membership check. Do NOT use `using (true)` or `auth.uid() is not null` for reads; those let any logged-in user read everyone's rows."
        : "Scope every RLS policy to the owning user — e.g. `using (auth.uid() = user_id)`. Do NOT use `using (true)`.",
    );
    reqs.push("Connect to the database as a non-privileged role so RLS is actually enforced.");
  }
  if (spec.storesData) {
    reqs.push("Use parameterized queries for all database access; never build SQL by string interpolation.");
  }
  reqs.push("Keep all secrets, API keys, and tokens in environment variables — never hardcode them in source.");
  if (sensitive) {
    reqs.push("Never log sensitive fields (PII / PHI / financial) or include them in error messages.");
  }
  return reqs;
}

/** Turn a ready PRD into the build instruction the generation engine receives. */
export function buildGenerationBrief(spec: Spec): string {
  const out: string[] = ["Build this application to the following specification.", ""];
  if (spec.summary) out.push(spec.summary, "");
  if (spec.users) out.push(`Users: ${spec.users}`);
  out.push(`Tenancy: ${spec.tenancy}`, `Authentication: ${spec.auth}`, "");

  if (spec.features.length) {
    out.push("Features:");
    for (const f of spec.features) out.push(`- ${f}`);
    out.push("");
  }
  if (spec.dataEntities.length) {
    out.push("Data model:");
    for (const e of spec.dataEntities) out.push(`- ${e.name}(${e.fields.join(", ")})${e.sensitive ? "  [sensitive]" : ""}`);
    out.push("");
  }

  if (spec.deployTarget === "downloadable-tool") {
    out.push(
      "DEPLOY TARGET: downloadable-tool — this is NOT a hosted web app. It runs on the user's own",
      "machine, invoked from a terminal; nobody reaches it over a URL. The build MUST satisfy every one:",
      "- Do NOT scaffold a web framework — no Next.js, Express, Fastify, or any other HTTP server.",
      "- Do NOT create a `Dockerfile` meant for a deployed service.",
      "- Build a runnable CLI/script entry point instead: a `package.json` with a `bin` field, or a",
      "  plain `main` script that runs to completion and exits — or, for Python, a `main.py` / script",
      "  invoked directly.",
      "- The app must be runnable via a single command with no network server involved.",
      "",
    );
  }

  const reqs = securityRequirements(spec);
  if (reqs.length) {
    out.push("SECURITY REQUIREMENTS — these are checked by automated gates; the build MUST satisfy every one:");
    for (const r of reqs) out.push(`- ${r}`);
  }
  return out.join("\n");
}
