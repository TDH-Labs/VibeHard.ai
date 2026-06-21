/**
 * Dependency-vulnerability gate — trivy (pinned container) scanning the project's
 * dependency manifests/lockfiles for known CVEs (PROJECT_BRIEF.md §15 NEXT, §17,
 * §19). Polyglot + container + parse-JSON, same pattern as sast/secrets (§4).
 *
 * Pure parser (`parseTrivy`) + pure fail-closed interpretation (`interpretTrivy`)
 * are unit-tested without a container; the container run is the only I/O. Per the
 * §11 fail-closed invariant, a scan that did NOT run returns a CRITICAL
 * `scan-failed` (which blocks) — never a silent pass.
 */
import { resolve } from "node:path";
import type { Finding, GateVerdict, Severity } from "../types.ts";
import { verdictOf } from "../types.ts";

const TRIVY_IMAGE = "aquasec/trivy:0.58.1";
/** Persist trivy's vuln DB across runs so it's downloaded once, not every scan. */
const TRIVY_CACHE_VOLUME = "drydock-trivy-cache";

/** trivy severity → our scale (CRITICAL/HIGH block; MEDIUM/LOW are reported, not blocking). */
export function mapTrivySeverity(s: string | undefined): Severity {
  switch ((s ?? "").toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "medium";
    default:
      return "low"; // LOW / UNKNOWN
  }
}

/** Pure: trivy `fs` JSON → Finding[]. No I/O. */
export function parseTrivy(raw: unknown): Finding[] {
  const results = (raw as { Results?: unknown[] } | null)?.Results ?? [];
  const findings: Finding[] = [];
  for (const r of results) {
    const target = String((r as { Target?: string }).Target ?? "");
    const vulns = (r as { Vulnerabilities?: unknown[] }).Vulnerabilities ?? [];
    for (const v of vulns ?? []) {
      const x = v as {
        VulnerabilityID?: string;
        PkgName?: string;
        InstalledVersion?: string;
        FixedVersion?: string;
        Severity?: string;
        Title?: string;
      };
      const fix = x.FixedVersion ? `fixed in ${x.FixedVersion}` : "no fix available yet";
      findings.push({
        tool: "trivy",
        ruleId: String(x.VulnerabilityID ?? "unknown"),
        severity: mapTrivySeverity(x.Severity),
        file: target,
        message: `${x.PkgName ?? "?"}@${x.InstalledVersion ?? "?"}: ${String(x.Title ?? "known vulnerability").trim()} (${fix})`,
      });
    }
  }
  return findings;
}

function scanFailed(exitCode: number, stderr: string, target: string): Finding {
  return {
    tool: "trivy",
    ruleId: "scan-failed",
    severity: "critical",
    file: target,
    message: `Dependency scan did not run (exit ${exitCode}) — failing closed. ${stderr.trim().slice(0, 200)}`.trim(),
  };
}

/**
 * Pure: a trivy run → Finding[], failing CLOSED (§11). trivy `fs` exits 0 on a
 * SUCCESSFUL scan whether or not it finds vulns (we do NOT pass --exit-code), and
 * emits `Results: null` for a project with no dependency manifests. So "it ran" is
 * proven by *exit 0 + a valid JSON report object* — NOT by `Results` being an array
 * (requiring that would false-fail a legitimate no-dependency project). A non-zero
 * exit or unparseable output means the scan did not run → CRITICAL `scan-failed`.
 */
export function interpretTrivy(stdout: string, exitCode: number, stderr: string, target: string): Finding[] {
  if (exitCode !== 0) return [scanFailed(exitCode, stderr, target)];
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  if (json === null || typeof json !== "object") return [scanFailed(exitCode, stderr, target)];
  return parseTrivy(json); // Results ?? [] → a clean no-deps scan yields no findings (PASS)
}

/** Run trivy in a pinned container against `projectPath` and return a verdict. */
export async function runDepVuln(
  projectPath: string,
  ranAt: string = new Date().toISOString(),
): Promise<GateVerdict> {
  // Docker bind mounts require an absolute source — a relative path becomes an empty
  // named volume that scans nothing → false PASS (the §11 class, same as sast/secrets).
  const absPath = resolve(projectPath);
  const proc = Bun.spawnSync([
    "docker", "run", "--rm",
    "-v", `${absPath}:/src:ro`,
    "-v", `${TRIVY_CACHE_VOLUME}:/root/.cache/trivy`,
    TRIVY_IMAGE, "fs", "--quiet", "--format", "json", "--scanners", "vuln", "/src",
  ]);
  const findings = interpretTrivy(
    proc.stdout?.toString() ?? "",
    proc.exitCode ?? -1,
    proc.stderr?.toString() ?? "",
    absPath,
  );
  return verdictOf("depvuln", findings, ranAt);
}

export const depvulnGate = { name: "depvuln", run: (p: string) => runDepVuln(p) };
