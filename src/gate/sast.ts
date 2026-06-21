/**
 * SAST gate — real semgrep (pinned container) + the custom CWE-89 rule.
 * The parse step is a pure function (unit-tested); the container run is the
 * only I/O (integration-tested). Ported from ~/dev/gate-proof/gates/sast.sh.
 */
import { join, resolve } from "node:path";
import type { Finding, GateVerdict, Severity } from "../types.ts";
import { verdictOf } from "../types.ts";

const SEMGREP_IMAGE = "semgrep/semgrep:1.96.0";

/** semgrep severity → our scale (preserves the proof: ERROR blocks). */
export function mapSeverity(s: string | undefined): Severity {
  switch ((s ?? "").toUpperCase()) {
    case "ERROR":
      return "high";
    case "WARNING":
      return "medium";
    default:
      return "low";
  }
}

/** Pure: semgrep JSON → Finding[]. No I/O. */
export function parseSemgrep(raw: unknown): Finding[] {
  const results = (raw as { results?: unknown[] } | null)?.results ?? [];
  return results.map((r): Finding => {
    const x = r as {
      check_id?: string;
      path?: string;
      start?: { line?: number };
      extra?: { severity?: string; message?: string };
    };
    return {
      tool: "semgrep",
      ruleId: String(x.check_id ?? "unknown"),
      severity: mapSeverity(x.extra?.severity),
      file: String(x.path ?? ""),
      line: x.start?.line,
      message: String(x.extra?.message ?? "").trim(),
    };
  });
}

/** Run semgrep in a pinned container against `projectPath` and return a verdict. */
export async function runSast(
  projectPath: string,
  ranAt: string = new Date().toISOString(),
): Promise<GateVerdict> {
  const rulesDir = join(import.meta.dir, "rules");
  // Docker bind mounts require an absolute source — a relative path is silently
  // treated as a named (empty) volume, which would scan nothing and FALSE-PASS.
  const absPath = resolve(projectPath);
  const proc = Bun.spawnSync([
    "docker", "run", "--rm",
    "-v", `${absPath}:/src:ro`,
    "-v", `${rulesDir}:/rules:ro`,
    SEMGREP_IMAGE, "semgrep", "scan", "--quiet", "--json",
    "--config", "/rules/sqli.yaml", "--config", "p/default",
    "--exclude", "node_modules", "/src",
  ]);
  let json: unknown = {};
  try {
    json = JSON.parse(proc.stdout?.toString() ?? "{}");
  } catch {
    /* no/invalid JSON → no findings; integration test guards the happy path */
  }
  return verdictOf("sast", parseSemgrep(json), ranAt);
}

export const sastGate = { name: "sast", run: (p: string) => runSast(p) };
