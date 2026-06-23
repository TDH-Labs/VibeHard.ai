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
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";
import { coerceSpec, decideRigor, type Rigor } from "../spec/index.ts";
import { DERIVED_DIRS } from "./scan-scope.ts";

const RUNS = 3; // default when rigor is unknown; see verifyRuns
const PROBE_ATTEMPTS = 30; // ~3s: PROBE_ATTEMPTS × PROBE_INTERVAL_MS
const PROBE_INTERVAL_MS = 100;
const SHUTDOWN_GRACE_MS = 5000; // §18: a served app must exit on SIGTERM within this
const CLEAN_TIMEOUT_MS = 120_000; // §18: clean-env install/build under a portable timeout
/** Probe order: the conventional health route first, then root. The first to
 *  return an "up" status wins — an app serving either has booted. */
const PROBE_PATHS = ["/health", "/"] as const;

/** §18/§16 adaptive rigor: how many launch runs to require. "Pass" = ALL N green —
 *  one flake fails the gate. prototype 1 · default 3 (rigor unknown) · production 5. */
export function verifyRuns(rigor: Rigor | null): number {
  return rigor === "production" ? 5 : rigor === "prototype" ? 1 : 3;
}

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
  /** did the process exit on SIGTERM within the grace window (vs needing SIGKILL)? */
  cleanShutdown?: boolean;
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

/** Pure (§18 graceful shutdown): an app that came up but had to be force-killed
 *  (didn't exit on SIGTERM within the grace window) → an advisory. It ran, so this
 *  doesn't block; but it risks dropping in-flight requests on a deploy restart. */
export function summarizeShutdown(runs: VerifyRun[]): Finding[] {
  const unclean = runs.some((r) => isUp(r.status) && r.cleanShutdown === false);
  if (!unclean) return [];
  return [
    {
      tool: "verify",
      ruleId: "unclean-shutdown",
      severity: "medium",
      file: "server.js",
      message: `The app didn't exit within ${SHUTDOWN_GRACE_MS / 1000}s of SIGTERM and had to be force-killed — on a deploy restart or scale-down it may drop in-flight requests. Handle SIGTERM to shut down gracefully.`,
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

/** How to verify a project boots: launch a node server, launch a python server, build a static app, or nothing. */
export type LaunchPlan =
  | { kind: "node"; entry: string }
  | { kind: "python"; cmd: string[] }
  | { kind: "build"; script: string }
  | null;

/** A Python web entry module (the language-expansion path: any language on Supabase). */
export function pythonEntry(projectPath: string): string | null {
  for (const c of ["main.py", "app.py", "asgi.py", "wsgi.py", "server.py"]) {
    if (existsSync(join(projectPath, c))) return c;
  }
  return null;
}

/**
 * Pure: the launch command for a Python web app, with the port as the literal "$PORT"
 * (substituted at spawn). Pick the server for the framework declared in `deps`
 * (requirements.txt / pyproject text): uvicorn for FastAPI/ASGI; otherwise plain
 * `python <entry>` (Flask/a script reads PORT from the environment). The uvicorn module
 * is the entry minus its `.py`.
 */
export function pythonStartCommand(entry: string, deps: string): string[] {
  const mod = entry.replace(/\.py$/, "");
  if (/\b(uvicorn|fastapi)\b/i.test(deps)) return ["uvicorn", `${mod}:app`, "--host", "0.0.0.0", "--port", "$PORT"];
  return ["python", entry];
}

function readPyDeps(projectPath: string): string {
  return ["requirements.txt", "pyproject.toml"]
    .map((f) => {
      try {
        const p = join(projectPath, f);
        return existsSync(p) ? readFileSync(p, "utf8") : "";
      } catch {
        return "";
      }
    })
    .join("\n");
}

/** Pure-ish (reads package.json / requirements): pick the launch strategy. A node entry
 *  wins, then a Python web app, then a `build` script (static/SPA build-verify). */
export function detectLaunch(projectPath: string): LaunchPlan {
  const entry = findEntry(projectPath);
  if (entry) return { kind: "node", entry };
  if (existsSync(join(projectPath, "requirements.txt")) || existsSync(join(projectPath, "pyproject.toml"))) {
    const pe = pythonEntry(projectPath);
    if (pe) return { kind: "python", cmd: pythonStartCommand(pe, readPyDeps(projectPath)) };
  }
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

/** Install Python deps for a from-source app (pip). Returns a finding on failure, else null. */
function ensurePythonInstalled(projectPath: string, env: Record<string, string | undefined>): Finding | null {
  if (!existsSync(join(projectPath, "requirements.txt"))) return null; // pyproject-only → assume the runtime provides them (v1)
  const install = Bun.spawnSync(["pip", "install", "-r", "requirements.txt"], { cwd: projectPath, env, stdout: "pipe", stderr: "pipe" });
  if ((install.exitCode ?? 1) === 0) return null;
  const log = `${install.stdout?.toString() ?? ""}${install.stderr?.toString() ?? ""}`.trim();
  return {
    tool: "verify",
    ruleId: "install-failed",
    severity: "high",
    file: "requirements.txt",
    message: `\`pip install -r requirements.txt\` exited ${install.exitCode} — the app's Python dependencies don't install, so it cannot run${log ? ` — error: ${log.slice(-600)}` : ""}`,
  };
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

/** Read the rigor the front-half persisted (.drydock/spec.json). Null → unknown
 *  (default rigor — 3 runs, no heavy clean-env check). */
function readRigor(projectPath: string): Rigor | null {
  const p = join(projectPath, ".drydock", "spec.json");
  if (!existsSync(p)) return null;
  try {
    return decideRigor(coerceSpec(JSON.parse(readFileSync(p, "utf8"))));
  } catch {
    return null;
  }
}

const COPY_EXCLUDE = new Set<string>(DERIVED_DIRS);

/**
 * Clean-env verify (§18): prove a FRESH machine can install + build — copy the
 * AUTHORED source (no node_modules / derived) to a temp dir, install from scratch
 * (`npm ci` if a lockfile, else `npm install`), then build. Catches "works on my
 * machine": an undeclared dependency that's present locally, or lockfile drift. Heavy
 * (a from-scratch install) → run at production rigor only, ONCE, before the loop.
 */
async function cleanEnvVerify(projectPath: string, env: Record<string, string | undefined>): Promise<Finding[]> {
  const pkg = readPkg(projectPath);
  if (!pkg || !hasDeps(pkg)) return []; // nothing to install → not applicable
  let tmp: string;
  try {
    tmp = mkdtempSync(join(tmpdir(), "drydock-clean-"));
  } catch (e) {
    return [cleanFinding("copy", String(e))]; // §11 fail-closed: couldn't run the check
  }
  try {
    cpSync(projectPath, tmp, {
      recursive: true,
      // skip derived dirs by basename → a fresh tree, like a clean checkout
      filter: (src) => !COPY_EXCLUDE.has(src.split("/").pop() ?? ""),
    });
    const cmd = existsSync(join(tmp, "package-lock.json"))
      ? ["npm", "ci", "--no-audit", "--no-fund"]
      : ["npm", "install", "--no-audit", "--no-fund"];
    const install = Bun.spawnSync(cmd, { cwd: tmp, env, stdout: "pipe", stderr: "pipe", timeout: CLEAN_TIMEOUT_MS });
    if ((install.exitCode ?? 1) !== 0) {
      return [cleanFinding("install", `${install.stdout?.toString() ?? ""}${install.stderr?.toString() ?? ""}`)];
    }
    if (pkg.scripts?.build) {
      const build = Bun.spawnSync(["npm", "run", "build"], { cwd: tmp, env, stdout: "pipe", stderr: "pipe", timeout: CLEAN_TIMEOUT_MS });
      if ((build.exitCode ?? 1) !== 0) {
        return [cleanFinding("build", `${build.stdout?.toString() ?? ""}${build.stderr?.toString() ?? ""}`)];
      }
    }
    return [];
  } catch (e) {
    return [cleanFinding("copy", String(e))];
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

function cleanFinding(stage: "copy" | "install" | "build", log: string): Finding {
  const what = stage === "build" ? "`npm run build`" : stage === "install" ? "`npm ci` / `npm install`" : "copying the source";
  const tail = log.trim() ? ` — error: ${log.trim().slice(-500)}` : "";
  return {
    tool: "verify",
    ruleId: "clean-verify-failed",
    severity: "high",
    file: "package.json",
    message: `On a clean machine (fresh copy, no node_modules), ${what} failed — the app works locally but not from scratch (an undeclared dependency or lockfile drift)${tail}`,
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
  cmd: string[],
  port: number,
  env: Record<string, string | undefined>,
): Promise<{ status: number; log: string; cleanShutdown: boolean }> {
  const resolved = cmd.map((a) => (a === "$PORT" ? String(port) : a)); // port templated for uvicorn etc.
  const proc = Bun.spawn(resolved, {
    cwd: projectPath,
    env: { ...env, PORT: String(port) }, // node/Flask read PORT from env; uvicorn from --port
    stdout: "pipe",
    stderr: "pipe",
  });
  let status = 0;
  let cleanShutdown = true;
  try {
    for (let i = 0; i < PROBE_ATTEMPTS; i++) {
      await Bun.sleep(PROBE_INTERVAL_MS);
      status = await probePaths(port);
      if (status) break;
    }
  } finally {
    // §18 graceful shutdown: SIGTERM, then up to SHUTDOWN_GRACE_MS to exit. A clean
    // app exits at once (the sleep is abandoned); one that hangs is force-killed and
    // marked unclean. (A well-behaved process adds ~0ms here.)
    proc.kill(); // SIGTERM
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(SHUTDOWN_GRACE_MS).then(() => false)]);
    if (!exited) {
      cleanShutdown = false;
      proc.kill(9); // SIGKILL
      await proc.exited.catch(() => {});
    }
  }
  const out = await new Response(proc.stdout).text().catch(() => "");
  const err = await new Response(proc.stderr).text().catch(() => "");
  // Prefer stderr — that's where a crash trace lands; fall back to stdout.
  return { status, log: err.trim() || out.trim(), cleanShutdown };
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

  const env = { ...synthEnv(readEnvTemplates(projectPath)), ...process.env };
  const rigor = readRigor(projectPath);
  const findings: Finding[] = [];

  // §18 clean-env verify (production rigor, heavy): prove a fresh machine can
  // install + build. Runs ONCE, before the path-specific check.
  if (rigor === "production") findings.push(...(await cleanEnvVerify(projectPath, env)));

  if (plan.kind === "build") {
    findings.push(...summarizeBuild(await runBuild(projectPath, plan.script)));
    return verdictOf("verify", findings, ranAt);
  }

  // A launched app (node or python) can't run without its deps; a fresh generation has none yet.
  if (plan.kind === "python") {
    const f = ensurePythonInstalled(projectPath, env);
    if (f) {
      findings.push(f);
      return verdictOf("verify", findings, ranAt);
    }
  } else {
    const installFail = ensureInstalled(projectPath, env);
    if (installFail) {
      findings.push(...summarizeBuild(installFail));
      return verdictOf("verify", findings, ranAt);
    }
  }
  const launchCmd = plan.kind === "node" ? ["node", plan.entry] : plan.cmd;
  // §18 adaptive: ALL N runs must come up healthy (N scales with rigor).
  const required = verifyRuns(rigor);
  const runs: VerifyRun[] = [];
  for (let i = 1; i <= required; i++) {
    const { status, log, cleanShutdown } = await probeOnce(projectPath, launchCmd, 4100 + i, env);
    runs.push({ run: i, status, log, cleanShutdown });
  }
  findings.push(...summarizeVerify(runs, required), ...summarizeShutdown(runs));
  return verdictOf("verify", findings, ranAt);
}

export const verifyGate = { name: "verify", run: (p: string) => runVerify(p) };
