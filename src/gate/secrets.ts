/**
 * Secrets gate — real gitleaks (pinned container). Pure parser + container run,
 * same shape as the SAST gate. Ported from ~/dev/gate-proof/gates/secrets.sh.
 * Any leaked secret is blocking regardless of severity (see types.isBlocking).
 */
import { resolve } from "node:path";
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";

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
  const proc = Bun.spawnSync([
    "docker", "run", "--rm",
    "-v", `${absPath}:/src:ro`,
    GITLEAKS_IMAGE, "detect", "--source=/src", "--no-git",
    "--report-format", "json", "--report-path", "/dev/stdout",
  ]);
  let json: unknown = [];
  try {
    json = JSON.parse(proc.stdout?.toString() || "[]");
  } catch {
    /* no/invalid JSON → no findings; integration test guards the happy path */
  }
  return verdictOf("secrets", parseGitleaks(json), ranAt);
}

export const secretsGate = { name: "secrets", run: (p: string) => runSecrets(p) };
