/**
 * Specialty routing (PROJECT_BRIEF.md §3, §11 "Escalation trigger + packet +
 * specialty routing → Deterministic"). When a gate flags a judgment call, the
 * localized slice is routed to the right specialty (a Harbor "room"). The human
 * supplies the judgment; this mapping — which specialty — is deterministic code.
 *
 * Pure, total, unit-tested. Keyed on the finding's tool because that's the stable
 * signal (the scanner that produced it), not the free-text message.
 */
import type { Finding } from "../types.ts";

export type Specialty = "security" | "database" | "reliability" | "general";

export function routeFinding(f: Finding): Specialty {
  switch (f.tool) {
    case "semgrep": // SAST: injection, XSS, eval, crypto, …
    case "gitleaks": // leaked credentials
      return "security";
    case "rls": // Supabase Row-Level Security — needs a Postgres/RLS specialist
      return "database";
    case "verify": // the app doesn't reliably boot/serve
      return "reliability";
    default:
      return "general";
  }
}
