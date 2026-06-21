/**
 * Verify gate — proves a generated app is runnable before deploy
 * (PROJECT_BRIEF.md §12). Ported from ~/dev/gate-proof/gates/verify.sh, then
 * hardened for the two app shapes the generator produces:
 *
 *   • a node SERVER (server.js / package.json main) → launch + probe /health N
 *     times; one green run proves nothing, so EVERY run must be healthy.
 *   • a static/SPA BUILD (a `build` script, no server) → `npm run build` must
 *     succeed; a SPA that builds is deployable, and the deploy target serves the
 *     output — so we verify the build, not a dev server (no port/process hazards).
 *
 * Pure dispositions (`summarizeVerify`, `summarizeBuild`, `detectLaunch`) are
 * separated from the I/O (spawning node/npm) and unit-tested; the launches are
 * integration-tested.
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

interface Pkg {
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPkg(projectPath: string): Pkg | null {
  const p = join(projectPath, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Pkg;
  } catch {
    return null;
  }
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
  const pkg = readPkg(projectPath);
  const candidates: string[] = [];
  if (pkg?.main) candidates.push(pkg.main);
  candidates.push("server.js", "index.js", "app.js");
  for (const c of candidates) if (existsSync(join(projectPath, c))) return c;
  return null;
}

/** How to verify a project boots: launch a node server, build a static app, or nothing. */
export type LaunchPlan = { kind: "node"; entry: string } | { kind: "build"; script: string } | null;

/** Pure-ish (reads package.json): pick the launch strategy. A node entry wins;
 *  otherwise a `build` script means a static/SPA app to build-verify. */
export function detectLaunch(projectPath: string): LaunchPlan {
  const entry = findEntry(projectPath);
  if (entry) return { kind: "node", entry };
  const pkg = readPkg(projectPath);
  if (pkg?.scripts?.build) return { kind: "build", script: "build" };
  return null;
}

/** Outcome of build-verifying a static app — which stage ran and its exit code. */
export interface BuildOutcome {
  stage: "install" | "build";
  exitCode: number;
}

/** Pure: a build outcome → Finding[]. A non-zero install or build blocks the deploy. */
export function summarizeBuild(outcome: BuildOutcome): Finding[] {
  if (outcome.exitCode === 0) return [];
  const what = outcome.stage === "install" ? "`npm install`" : "`npm run build`";
  return [
    {
      tool: "verify",
      ruleId: outcome.stage === "install" ? "install-failed" : "build-failed",
      severity: "high",
      file: "package.json",
      message: `${what} exited ${outcome.exitCode} — the app does not build, so it cannot be deployed`,
    },
  ];
}

function hasDeps(pkg: Pkg): boolean {
  return (
    Object.keys(pkg.dependencies ?? {}).length > 0 || Object.keys(pkg.devDependencies ?? {}).length > 0
  );
}

/** Install (only if deps are declared and absent) then run the build script. */
async function runBuild(projectPath: string, script: string): Promise<BuildOutcome> {
  const pkg = readPkg(projectPath);
  if (pkg && hasDeps(pkg) && !existsSync(join(projectPath, "node_modules"))) {
    const install = Bun.spawnSync(["npm", "install", "--no-audit", "--no-fund"], {
      cwd: projectPath,
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((install.exitCode ?? 1) !== 0) return { stage: "install", exitCode: install.exitCode ?? 1 };
  }
  const build = Bun.spawnSync(["npm", "run", script], { cwd: projectPath, stdout: "ignore", stderr: "ignore" });
  return { stage: "build", exitCode: build.exitCode ?? 1 };
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

/** Verify `projectPath` boots: launch-probe a server, or build-verify a static app. */
export async function runVerify(
  projectPath: string,
  ranAt: string = new Date().toISOString(),
): Promise<GateVerdict> {
  const plan = detectLaunch(projectPath);

  if (!plan) {
    return verdictOf(
      "verify",
      [
        {
          tool: "verify",
          ruleId: "no-entry-point",
          severity: "high",
          file: projectPath,
          message:
            "no launchable entry point (package.json main / server.js) and no build script — cannot verify the app boots",
        },
      ],
      ranAt,
    );
  }

  if (plan.kind === "build") {
    return verdictOf("verify", summarizeBuild(await runBuild(projectPath, plan.script)), ranAt);
  }

  const runs: VerifyRun[] = [];
  for (let i = 1; i <= RUNS; i++) {
    runs.push({ run: i, status: await probeOnce(projectPath, plan.entry, 4100 + i) });
  }
  return verdictOf("verify", summarizeVerify(runs), ranAt);
}

export const verifyGate = { name: "verify", run: (p: string) => runVerify(p) };
