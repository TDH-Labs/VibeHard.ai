/**
 * Secrets gate — real gitleaks (pinned container). Pure parser + container run,
 * same shape as the SAST gate. Ported from ~/dev/gate-proof/gates/secrets.sh.
 * Any leaked secret is blocking regardless of severity (see types.isBlocking).
 */
import { join, resolve } from "node:path";
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";
import { hasAuthoredSource } from "./scan-scope.ts";

const GITLEAKS_IMAGE = "zricethezav/gitleaks:v8.18.4";

/** Pure: gitleaks JSON (an array of leaks) → Finding[]. No I/O. */
export function parseGitleaks(raw: unknown): Finding[] {
  const items = Array.isArray(raw) ? raw : [];
  return items.map((r): Finding => {
    const g = r as { RuleID?: string; Description?: string; File?: string; StartLine?: number };
    return {
      tool: "gitleaks",
      ruleId: String(g.RuleID ?? "unknown"),
      severity: "high",
      file: String(g.File ?? ""),
      line: g.StartLine,
      message: String(g.Description ?? "leaked secret").trim(),
    };
  });
}

/** Run gitleaks in a pinned container against `projectPath` and return a verdict. */
export async function runSecrets(
  projectPath: string,
  ranAt: string = new Date().toISOString(),
): Promise<GateVerdict> {
  // Absolute source required — a relative bind mount becomes an empty named
  // volume (scans nothing → false PASS). Resolve before handing it to Docker.
  const absPath = resolve(projectPath);
  // §11 fail-closed: no authored source (only derived/build output, or empty) →
  // with the path allowlist active, gitleaks would scan nothing → false PASS.
  if (!hasAuthoredSource(absPath)) {
    return verdictOf(
      "secrets",
      [{ tool: "gitleaks", ruleId: "scan-failed", severity: "critical", file: absPath, message: "Secret scan saw no authored source to scan (only derived/build output) — failing closed (§11)." }],
      ranAt,
    );
  }
  const rulesDir = join(import.meta.dir, "rules");
  const proc = Bun.spawnSync([
    "docker", "run", "--rm",
    "-v", `${absPath}:/src:ro`,
    "-v", `${rulesDir}:/rules:ro`,
    GITLEAKS_IMAGE, "detect", "--source=/src", "--no-git",
    "--config=/rules/gitleaks.toml", // keep default rules; allowlist derived dirs (§11)
    "--report-format", "json", "--report-path", "/dev/stdout",
  ]);
  const findings = interpretGitleaks(
    proc.stdout?.toString() ?? "",
    proc.exitCode ?? -1,
    proc.stderr?.toString() ?? "",
    absPath,
  );
  return verdictOf("secrets", findings, ranAt);
}

/**
 * Pure: a gitleaks run's output → Finding[], failing CLOSED. gitleaks exits
 * 0 = clean, 1 = leaks found, >1 = error. An error (or non-array output) means
 * the scan did not run — return a CRITICAL `scan-failed` finding (which blocks),
 * never a silent pass. (PROJECT_BRIEF §11 fail-closed invariant.)
 */
export function interpretGitleaks(
  stdout: string,
  exitCode: number,
  stderr: string,
  target: string,
): Finding[] {
  if (exitCode > 1) {
    return [
      {
        tool: "gitleaks",
        ruleId: "scan-failed",
        severity: "critical",
        file: target,
        message: `Secret scan did not run (exit ${exitCode}) — failing closed. ${stderr.trim().slice(0, 200)}`.trim(),
      },
    ];
  }
  let json: unknown;
  try {
    json = JSON.parse(stdout || "[]");
  } catch {
    json = null;
  }
  if (!Array.isArray(json)) {
    return [
      {
        tool: "gitleaks",
        ruleId: "scan-failed",
        severity: "critical",
        file: target,
        message: `Secret scan produced no valid report (exit ${exitCode}) — failing closed.`,
      },
    ];
  }
  return parseGitleaks(json);
}

export const secretsGate = { name: "secrets", run: (p: string) => runSecrets(p) };
