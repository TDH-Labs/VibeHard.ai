/**
 * PII-leak gate (backlog #7, BOUNDED BY §16). The secrets gate catches hardcoded CREDENTIALS;
 * this catches PERSONAL DATA leaking out of the app through two deterministic, high-signal paths:
 *   • PII written to LOGS (logs are routinely shipped to third parties + kept unprotected), and
 *   • PII read from a URL / query string (URLs are logged by servers, proxies, and browser history).
 *
 * CLASSIFICATION-DRIVEN like the compliance gate: it reads the spec the front-half persisted
 * (.vibehard/spec.json) and only assesses an app whose data is sensitive — otherwise it's a no-op,
 * so it never false-positives a throwaway. Findings are `high` → BLOCKING for a sensitive app
 * (a real leak must not ship). Detection keys on PROPERTY ACCESS / INTERPOLATION of a PII field,
 * not bare string labels, so `console.log("email sent")` does NOT trip it.
 *
 * Pure `scanPii` (the detection) is split from the I/O (spec + file walk) and unit-tested.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";
import type { SensitiveClass } from "../spec/index.ts";
import { DERIVED_DIRS } from "./scan-scope.ts";

const DERIVED = new Set<string>(DERIVED_DIRS);
const SENSITIVE: readonly SensitiveClass[] = ["pii", "phi", "financial", "credentials"];

// Personal-data field terms (broad but high-signal). Dots tolerate snake/kebab/space variants.
const PII = "email|ssn|social.?security|date.?of.?birth|dob|birth.?date|phone|passport|driver.?s?.?licen[sc]e|credit.?card|card.?number|cvv|cvc|bank.?account|routing.?number|tax.?id|national.?id|patient|diagnosis|medical.?record|health.?record|home.?address|street.?address|full.?name|password|passwd";
const LOG = "(?:console\\.(?:log|info|warn|error|debug)|logger\\.\\w+|logging\\.\\w+|\\bprint)\\s*\\(";

/** A log call that references a PII field by PROPERTY ACCESS (`user.email`) or INTERPOLATION
 *  (`${user.ssn}`) — not a quoted label. */
const LOG_RE = new RegExp(`${LOG}.*?(?:\\.(?:${PII})|\\$\\{[^}]*\\b(?:${PII}))`, "i");
/** PII read out of a URL / query string (Express/Next, Flask, Django, FastAPI). */
const URL_RE = new RegExp(`(?:req\\.query\\.|\\.searchParams\\.get\\(\\s*['"\`]|\\.args\\.get\\(\\s*['"\`]|\\.GET\\.get\\(\\s*['"\`]|query_params\\.get\\(\\s*['"\`])(?:${PII})`, "i");

const finding = (ruleId: string, message: string, file: string): Finding => ({ tool: "pii", ruleId, severity: "high", file, message });

/** Pure: scan authored source for the two PII-leak patterns. Capped to bound noise. */
export function scanPii(files: Array<{ rel: string; code: string }>): Finding[] {
  const out: Finding[] = [];
  for (const { rel, code } of files) {
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]!;
      if (LOG_RE.test(ln)) {
        out.push(finding("pii-in-logs", `Personal data looks like it's written to logs (${rel}:${i + 1}). Logs are often unprotected — log an id, not the value, or redact it.`, `${rel}:${i + 1}`));
      } else if (URL_RE.test(ln)) {
        out.push(finding("pii-in-url", `Personal data is read from a URL / query string (${rel}:${i + 1}). URLs get logged by servers and proxies — send it in the request body instead.`, `${rel}:${i + 1}`));
      }
      if (out.length >= 20) return out;
    }
  }
  return out;
}

interface PersistedSpec {
  sensitiveData?: unknown;
  dataEntities?: Array<{ sensitive?: boolean }>;
}

/** True iff the spec classified the app's data as sensitive (PII/PHI/financial/credentials). */
function isSensitiveApp(projectPath: string): boolean {
  const p = join(projectPath, ".vibehard", "spec.json");
  if (!existsSync(p)) return false;
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as PersistedSpec;
    const declared = (Array.isArray(s.sensitiveData) ? s.sensitiveData : []).some((c): c is SensitiveClass => typeof c === "string" && SENSITIVE.includes(c as SensitiveClass));
    const entitySensitive = (s.dataEntities ?? []).some((e) => e?.sensitive);
    return declared || entitySensitive;
  } catch {
    return false;
  }
}

function walkCode(root: string, exts: string[]): Array<{ rel: string; code: string }> {
  const out: Array<{ rel: string; code: string }> = [];
  const walk = (dir: string, prefix: string): void => {
    try {
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

/** Run the PII-leak assessment. Non-sensitive app (or no spec) → PASS (no-op). */
export async function runPii(projectPath: string, ranAt: string = new Date().toISOString()): Promise<GateVerdict> {
  if (!isSensitiveApp(projectPath)) return verdictOf("pii", [], ranAt);
  return verdictOf("pii", scanPii(walkCode(projectPath, [".ts", ".tsx", ".js", ".jsx", ".py"])), ranAt);
}

export const piiGate = { name: "pii", run: (p: string) => runPii(p) };
