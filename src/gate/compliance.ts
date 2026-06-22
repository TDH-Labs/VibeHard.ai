/**
 * Compliance-posture gate (PROJECT_BRIEF.md §21, BOUNDED BY §16). RLS is one of the
 * seven controls a sensitive-data customer needs; this gate covers the rest. It is
 * CLASSIFICATION-DRIVEN: it reads the spec the front-half persisted (.drydock/spec.json)
 * and only assesses an app whose data is sensitive — otherwise it's a no-op.
 *
 * Disposition (§21):
 *   • verifiable technical controls missing → BLOCK (auth on sensitive data, a
 *     hard-delete path) — deterministically, like sast/rls;
 *   • org-level + judgment controls → SURFACED as advisories routed to a human
 *     (sanitization review, governance items, framework applicability).
 *
 * §16 BINDING — THE ONE INVARIANT: this assesses *controls and applicability*; it
 * NEVER claims or implies the app "is compliant/certified". Messages say "helps
 * toward", "applies at the org level", "does not satisfy or certify". RLS itself is
 * left to the `rls` gate (control 4) — not re-checked here.
 *
 * Pure `assessCompliance` (the seven-control logic) is split from the I/O (reading
 * the spec + scanning code) and unit-tested.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";
import type { SensitiveClass } from "../spec/index.ts";
import { DERIVED_DIRS } from "./scan-scope.ts";

const SENSITIVE_CLASSES: readonly SensitiveClass[] = ["pii", "phi", "financial", "credentials"];

/** The facts the assessment needs — extracted from the spec + a code scan. */
export interface ComplianceInput {
  sensitiveClasses: SensitiveClass[]; // the classified sensitive data (excluding "none")
  authenticated: boolean; // the app requires login
  storesData: boolean;
  hasDeletePath: boolean; // a hard-delete mechanism exists (not soft-delete only)
  suspiciousLogging: string[]; // file:line where sensitive fields may be logged
}

const finding = (ruleId: string, severity: Finding["severity"], message: string): Finding => ({
  tool: "compliance",
  ruleId,
  severity,
  file: "compliance",
  message,
});

/** Pure: the §21 seven-control posture for a sensitive app. Verifiable controls
 *  BLOCK (high/critical); org-level + judgment controls are advisory (low/medium).
 *  Non-sensitive → []. NEVER claims compliance (§16). */
export function assessCompliance(input: ComplianceInput): Finding[] {
  if (input.sensitiveClasses.length === 0) return []; // nothing sensitive → nothing to assess
  const out: Finding[] = [];
  const classes = input.sensitiveClasses.join(", ");

  // Control 3 — access control (BLOCK): sensitive data must sit behind authentication.
  if (!input.authenticated) {
    out.push(finding("unauthenticated-sensitive-data", "critical", `Sensitive data (${classes}) is exposed with no authentication — it must sit behind a login before this can ship.`));
  }

  // Control 2 — retention + deletion (BLOCK): a hard-delete path is required.
  if (input.storesData && !input.hasDeletePath) {
    out.push(finding("no-deletion-path", "high", `Sensitive data (${classes}) is stored with no hard-delete path — there must be a way to permanently delete a record (not just a soft-delete flag), to support retention and erasure obligations.`));
  }

  // Control 5 — sanitization (advisory: deterministic PII-in-log detection is fuzzy → route to a human).
  for (const site of input.suspiciousLogging) {
    out.push(finding("pii-logging-review", "medium", `A log statement at ${site} may write sensitive data in plaintext — review it and redact or remove the sensitive fields.`));
  }

  // Control 6 — governance (advisory: org-level, the build can only ENABLE these).
  out.push(finding("governance-posture", "low", `Org-level items to put in place for ${classes}: a data-handling policy, a breach-notification path, a data-processing agreement for any third parties, and a periodic access review. The build supports these; it does not establish them.`));

  // Control 7 — framework applicability (advisory: helps toward, never certifies).
  out.push(finding("compliance-applicability", "low", applicabilityMessage(input.sensitiveClasses)));

  return out;
}

function applicabilityMessage(classes: SensitiveClass[]): string {
  const areas = ["SOC 2 Security (always)", "SOC 2 Confidentiality (sensitive data)"];
  if (classes.includes("pii") || classes.includes("phi")) areas.push("SOC 2 Privacy (personal data)");
  if (classes.includes("financial")) areas.push("SOC 2 Processing Integrity (financial data)");
  return `Based on the data handled, these control areas likely apply at the ORGANIZATION level: ${areas.join("; ")}. These are organizational programs (audits, policies, attestations); the build helps toward the technical controls they require, but it does not satisfy or certify them.`;
}

// ── I/O ──────────────────────────────────────────────────────────────────────

const DERIVED = new Set<string>(DERIVED_DIRS);

interface PersistedSpec {
  sensitiveData?: unknown;
  dataEntities?: Array<{ sensitive?: boolean }>;
  auth?: string;
  storesData?: boolean;
}

/** Read the classification the front-half persisted to .drydock/spec.json. Null when
 *  the app never went through the front-half (then the gate no-ops — it can't assess
 *  compliance without a classification). */
function readClassification(projectPath: string): Pick<ComplianceInput, "sensitiveClasses" | "authenticated" | "storesData"> | null {
  const p = join(projectPath, ".drydock", "spec.json");
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as PersistedSpec;
    const declared = (Array.isArray(s.sensitiveData) ? s.sensitiveData : []).filter(
      (c): c is SensitiveClass => typeof c === "string" && SENSITIVE_CLASSES.includes(c as SensitiveClass),
    );
    const entitySensitive = (s.dataEntities ?? []).some((e) => e?.sensitive);
    const sensitiveClasses = declared.length ? [...new Set(declared)] : entitySensitive ? ["pii" as SensitiveClass] : [];
    return {
      sensitiveClasses,
      authenticated: (s.auth ?? "none") !== "none",
      storesData: s.storesData ?? (s.dataEntities?.length ?? 0) > 0,
    };
  } catch {
    return null;
  }
}

function walkCode(root: string, exts: string[]): Array<{ rel: string; code: string }> {
  const out: Array<{ rel: string; code: string }> = [];
  const walk = (dir: string, prefix: string): void => {
    try {
      // Inline readdirSync in the for-of so TS infers Dirent<string>[] (an explicit
      // annotation picks the Buffer-name overload).
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!DERIVED.has(e.name)) walk(join(dir, e.name), `${prefix}${e.name}/`);
        } else if (exts.some((x) => e.name.endsWith(x))) {
          try {
            const code = readFileSync(join(dir, e.name), "utf8");
            if (code.length < 300_000) out.push({ rel: `${prefix}${e.name}`, code });
          } catch {
            /* skip unreadable file */
          }
        }
      }
    } catch {
      /* unreadable dir → skip */
    }
  };
  walk(root, "");
  return out;
}

/** A hard-delete path exists if a migration has a `for delete` RLS policy, or the
 *  code has a DELETE handler / `.delete()` call / `DELETE FROM`. */
function detectDeletePath(projectPath: string): boolean {
  const re = /for\s+delete\b|\.delete\s*\(|delete\s+from\b|['"]DELETE['"]/i;
  return walkCode(projectPath, [".sql", ".ts", ".tsx", ".js", ".jsx"]).some(({ code }) => re.test(code));
}

/** Narrow heuristic: a console logger call that names a clearly-sensitive field. */
function detectSensitiveLogging(projectPath: string): string[] {
  const re = /console\.(?:log|error|warn|info)\([^)]*\b(?:password|passwd|ssn|social.?security|credit.?card|card.?number|cvv|secret|api.?key|private.?key)\b/i;
  const sites: string[] = [];
  for (const { rel, code } of walkCode(projectPath, [".ts", ".tsx", ".js", ".jsx"])) {
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) sites.push(`${rel}:${i + 1}`);
      if (sites.length >= 10) return sites; // cap the noise
    }
  }
  return sites;
}

/** Run the compliance-posture assessment. No classification or non-sensitive → PASS. */
export async function runCompliance(projectPath: string, ranAt: string = new Date().toISOString()): Promise<GateVerdict> {
  const cls = readClassification(projectPath);
  if (!cls || cls.sensitiveClasses.length === 0) return verdictOf("compliance", [], ranAt);
  const input: ComplianceInput = {
    ...cls,
    hasDeletePath: detectDeletePath(projectPath),
    suspiciousLogging: detectSensitiveLogging(projectPath),
  };
  return verdictOf("compliance", assessCompliance(input), ranAt);
}

export const complianceGate = { name: "compliance", run: (p: string) => runCompliance(p) };
