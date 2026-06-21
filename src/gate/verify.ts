/**
 * Verify gate — launch-probe, multi-run. Boots the app and probes /health N
 * times; one green run proves nothing, so the gate requires EVERY run healthy
 * (PROJECT_BRIEF.md §12). Ported from ~/dev/gate-proof/gates/verify.sh.
 *
 * Pure (the pass/fail disposition) is separated from the I/O (spawning node and
 * probing the port): `summarizeVerify` is unit-tested; `runVerify` does the launch.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";

const RUNS = 3;
const PROBE_ATTEMPTS = 30; // ~3s: PROBE_ATTEMPTS × PROBE_INTERVAL_MS
const PROBE_INTERVAL_MS = 100;

/** One launch+probe outcome: the HTTP status from /health (0 = never came up). */
export interface VerifyRun {
  run: number;
  status: number;
}

/**
 * Pure: launch outcomes → Finding[]. Blocking unless every required run was
 * healthy (200). A flaky or dead app must not ship. No I/O.
 */
export function summarizeVerify(runs: VerifyRun[], required: number = RUNS): Finding[] {
  const healthy = runs.filter((r) => r.status === 200).length;
  if (healthy === required && runs.length >= required) return [];
  return [
    {
      tool: "verify",
      ruleId: "health-check-failed",
      severity: "high",
      file: "server.js",
      message: `launch probe: ${healthy}/${required} runs returned 200 on /health — app is not reliably healthy`,
    },
  ];
}

/** Locate the node entry point to launch, relative to `projectPath`. */
export function findEntry(projectPath: string): string | null {
  const candidates: string[] = [];
  const pkgPath = join(projectPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { main?: string };
      if (pkg.main) candidates.push(pkg.main);
    } catch {
      /* unparseable package.json → fall through to conventional names */
    }
  }
  candidates.push("server.js", "index.js", "app.js");
  for (const c of candidates) if (existsSync(join(projectPath, c))) return c;
  return null;
}

/** Launch `node <entry>` in `projectPath` on `port`, probe /health once, tear down. */
async function probeOnce(projectPath: string, entry: string, port: number): Promise<number> {
  const proc = Bun.spawn(["node", entry], {
    cwd: projectPath,
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    for (let i = 0; i < PROBE_ATTEMPTS; i++) {
      await Bun.sleep(PROBE_INTERVAL_MS);
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        if (res.ok) return res.status;
      } catch {
        /* not up yet — keep polling until the attempt budget is spent */
      }
    }
    return 0;
  } finally {
    proc.kill();
    await proc.exited.catch(() => {});
  }
}

/** Run the multi-run launch probe against `projectPath` and return a verdict. */
export async function runVerify(
  projectPath: string,
  ranAt: string = new Date().toISOString(),
): Promise<GateVerdict> {
  const entry = findEntry(projectPath);
  if (!entry) {
    return verdictOf(
      "verify",
      [
        {
          tool: "verify",
          ruleId: "no-entry-point",
          severity: "high",
          file: projectPath,
          message: "no launchable entry point (package.json main / server.js) — cannot verify the app boots",
        },
      ],
      ranAt,
    );
  }
  const runs: VerifyRun[] = [];
  for (let i = 1; i <= RUNS; i++) {
    const status = await probeOnce(projectPath, entry, 4100 + i);
    runs.push({ run: i, status });
  }
  return verdictOf("verify", summarizeVerify(runs), ranAt);
}

export const verifyGate = { name: "verify", run: (p: string) => runVerify(p) };
