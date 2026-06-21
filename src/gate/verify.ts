/**
 * Verify gate — proves a generated app is runnable before deploy
 * (PROJECT_BRIEF.md §12). Ported from ~/dev/gate-proof/gates/verify.sh, then
 * hardened for the two app shapes the generator produces:
 *
 *   • a node SERVER (server.js / package.json main) → launch + probe N times;
 *     one green run proves nothing, so EVERY run must come up healthy.
 *   • a static/SPA BUILD (a `build` script, no server) → `npm run build` must
 *     succeed; a SPA that builds is deployable, and the deploy target serves the
 *     output — so we verify the build, not a dev server (no port/process hazards).
 *
 * Two hardenings learned from dogfooding real generated apps:
 *   • the launch probe tries /health THEN / (root). A generated server app won't
 *     always expose /health, but if it serves ANY 2xx/3xx it has booted — so we
 *     don't false-block a working app for lacking a conventional health route.
 *   • we inject dummy env (synthesized from .env.example) into the build/launch,
 *     so an app that reads required env at boot (e.g. SUPABASE_URL) doesn't crash
 *     on `undefined` and get misjudged as broken.
 *
 * Pure dispositions (`summarizeVerify`, `summarizeBuild`, `detectLaunch`, `isUp`,
 * `synthEnv`) are separated from the I/O (spawning node/npm) and unit-tested; the
 * launches are integration-tested.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";

const RUNS = 3;
const PROBE_ATTEMPTS = 30; // ~3s: PROBE_ATTEMPTS × PROBE_INTERVAL_MS
const PROBE_INTERVAL_MS = 100;
/** Probe order: the conventional health route first, then root. The first to
 *  return an "up" status wins — an app serving either has booted. */
const PROBE_PATHS = ["/health", "/"] as const;

/** A server is "up" if it answers with any 2xx or 3xx — it booted and is serving
 *  (a 3xx is the common "/ → /login" redirect of a server-rendered app). 4xx/5xx
 *  or no answer (0) mean it isn't serving. */
export function isUp(status: number): boolean {
  return status >= 200 && status < 400;
}

/** One launch+probe outcome: the HTTP status observed (0 = never came up), plus a
 *  tail of the process output so a boot crash is visible to the operator and the
 *  auto-fix loop (parallels BuildOutcome.log). */
export interface VerifyRun {
  run: number;
  status: number;
  log?: string;
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

/** Pure: parse the KEYS declared in a dotenv-style file (`KEY=...`, `export KEY=`),
 *  ignoring blanks and `#` comments. We only want the names, not the values. */
export function parseEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys.push(m[1]!);
  }
  return keys;
}

/** Pure: a syntactically-plausible dummy for an env var, so an app that reads it
 *  at boot/build doesn't crash on `undefined`. URL-shaped vars get a real URL
 *  (libraries like supabase-js throw on a non-URL); everything else a non-empty
 *  placeholder. This is for *booting*, never for authenticating. */
export function dummyEnvValue(key: string): string {
  const k = key.toUpperCase();
  if (/(URL|URI|ENDPOINT|ORIGIN|HOST)/.test(k)) return "http://localhost:54321";
  if (/PORT/.test(k)) return "3000";
  return "drydock-verify-placeholder";
}

/** Pure: dummy env map covering every key declared across the given dotenv sources
 *  (e.g. .env.example contents). Real process.env values should override these. */
export function synthEnv(sources: Array<string | null | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const src of sources) {
    if (!src) continue;
    for (const key of parseEnvKeys(src)) env[key] = dummyEnvValue(key);
  }
  return env;
}

/** Read the project's dotenv TEMPLATES (never a real .env) to learn which env the
 *  app expects, so the launch/build can supply dummies for them. */
function readEnvTemplates(projectPath: string): Array<string | null> {
  const read = (name: string): string | null => {
    const p = join(projectPath, name);
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  return [read(".env.example"), read(".env.sample"), read(".env.template")];
}

/**
 * Pure: launch outcomes → Finding[]. Blocking unless every required run was
 * healthy (200). A flaky or dead app must not ship. No I/O.
 */
export function summarizeVerify(runs: VerifyRun[], required: number = RUNS): Finding[] {
  const healthy = runs.filter((r) => isUp(r.status)).length;
  if (healthy === required && runs.length >= required) return [];
  // Surface the boot error (the last run that logged one) so the failure is
  // actionable — the operator and the auto-fix loop see WHAT crashed. A runtime
  // stack trace LEADS with the cause, so we keep the head (cf. summarizeBuild,
  // which tails because build tools print the error last).
  const log = [...runs].reverse().find((r) => r.log?.trim())?.log?.trim();
  const tail = log ? ` — error: ${log.slice(0, 600)}` : "";
  return [
    {
      tool: "verify",
      ruleId: "health-check-failed",
      severity: "high",
      file: "server.js",
      message: `launch probe: ${healthy}/${required} runs came up on /health or / — app is not reliably healthy${tail}`,
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

/** Outcome of build-verifying a static app — which stage ran, its exit code, and a
 *  tail of the build output (so the auto-fix loop knows WHAT broke, §18). */
export interface BuildOutcome {
  stage: "install" | "build";
  exitCode: number;
  log?: string;
}

/** Pure: a build outcome → Finding[]. A non-zero install or build blocks the deploy. */
export function summarizeBuild(outcome: BuildOutcome): Finding[] {
  if (outcome.exitCode === 0) return [];
  const what = outcome.stage === "install" ? "`npm install`" : "`npm run build`";
  const tail = outcome.log?.trim() ? ` — error: ${outcome.log.trim().slice(-600)}` : "";
  return [
    {
      tool: "verify",
      ruleId: outcome.stage === "install" ? "install-failed" : "build-failed",
      severity: "high",
      file: "package.json",
      message: `${what} exited ${outcome.exitCode} — the app does not build, so it cannot be deployed${tail}`,
    },
  ];
}

function hasDeps(pkg: Pkg): boolean {
  return (
    Object.keys(pkg.dependencies ?? {}).length > 0 || Object.keys(pkg.devDependencies ?? {}).length > 0
  );
}

/** Install deps when they are declared but node_modules is absent — a freshly
 *  GENERATED app has source but no installed deps, and you can neither build nor
 *  launch it without them (a node app would die with "Cannot find module"). Both
 *  verify paths need this. Returns null on success/nothing-to-do, or an install
 *  BuildOutcome on failure. */
function ensureInstalled(projectPath: string, env: Record<string, string | undefined>): BuildOutcome | null {
  const pkg = readPkg(projectPath);
  if (!pkg || !hasDeps(pkg) || existsSync(join(projectPath, "node_modules"))) return null;
  const install = Bun.spawnSync(["npm", "install", "--no-audit", "--no-fund"], {
    cwd: projectPath,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((install.exitCode ?? 1) !== 0) {
    return {
      stage: "install",
      exitCode: install.exitCode ?? 1,
      log: `${install.stdout?.toString() ?? ""}${install.stderr?.toString() ?? ""}`,
    };
  }
  return null;
}

/** Install (if needed) then run the build script. Dummy env (from .env.example)
 *  is injected so a build-time env read doesn't fail. */
async function runBuild(projectPath: string, script: string): Promise<BuildOutcome> {
  const env = { ...synthEnv(readEnvTemplates(projectPath)), ...process.env };
  const installFail = ensureInstalled(projectPath, env);
  if (installFail) return installFail;
  const build = Bun.spawnSync(["npm", "run", script], { cwd: projectPath, env, stdout: "pipe", stderr: "pipe" });
  return {
    stage: "build",
    exitCode: build.exitCode ?? 1,
    log: `${build.stdout?.toString() ?? ""}${build.stderr?.toString() ?? ""}`,
  };
}

/** Try each probe path once; return the first "up" status, else 0. Redirects are
 *  followed, so a `/ → /login` app resolves to its real page status. */
async function probePaths(port: number): Promise<number> {
  for (const path of PROBE_PATHS) {
    try {
      const res = await fetch(`http://localhost:${port}${path}`);
      if (isUp(res.status)) return res.status;
    } catch {
      /* this path not reachable yet — try the next */
    }
  }
  return 0;
}

/** Launch `node <entry>` in `projectPath` on `port`, poll until it comes up on any
 *  probe path (or the budget is spent), tear down. `env` carries dummy app env.
 *  Returns the status and a tail of the process output (captured so a boot crash
 *  is visible — drained after teardown; a boot stack trace is far under the cap). */
async function probeOnce(
  projectPath: string,
  entry: string,
  port: number,
  env: Record<string, string | undefined>,
): Promise<{ status: number; log: string }> {
  const proc = Bun.spawn(["node", entry], {
    cwd: projectPath,
    env: { ...env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  let status = 0;
  try {
    for (let i = 0; i < PROBE_ATTEMPTS; i++) {
      await Bun.sleep(PROBE_INTERVAL_MS);
      status = await probePaths(port);
      if (status) break;
    }
  } finally {
    proc.kill();
    await proc.exited.catch(() => {});
  }
  const out = await new Response(proc.stdout).text().catch(() => "");
  const err = await new Response(proc.stderr).text().catch(() => "");
  // Prefer stderr — that's where a crash trace lands; fall back to stdout.
  return { status, log: err.trim() || out.trim() };
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

  const env = { ...synthEnv(readEnvTemplates(projectPath)), ...process.env };
  // A node app can't launch without its deps; a fresh generation has none yet.
  const installFail = ensureInstalled(projectPath, env);
  if (installFail) return verdictOf("verify", summarizeBuild(installFail), ranAt);
  const runs: VerifyRun[] = [];
  for (let i = 1; i <= RUNS; i++) {
    const { status, log } = await probeOnce(projectPath, plan.entry, 4100 + i, env);
    runs.push({ run: i, status, log });
  }
  return verdictOf("verify", summarizeVerify(runs), ranAt);
}

export const verifyGate = { name: "verify", run: (p: string) => runVerify(p) };
