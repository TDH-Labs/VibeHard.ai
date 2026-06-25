/**
 * `vibehard diagnose <dir>` — fast, one-shot triage of a generated/held app. It turns
 * the forensic dig a held build used to require (snapshot, `npm ci`, build, grep,
 * compare lockfile, eyeball mtimes) into a few seconds of structured output.
 *
 * Two tiers, matching the two debugging speeds:
 *  - STATIC (default, milliseconds): dependency truth (declared vs installed vs locked
 *    vs imported), undeclared imports, lockfile drift, and the `.vibehard` pipeline
 *    state + any held ticket. Catches the entire dependency failure class without a build.
 *  - BUILD (`--build`, minutes): snapshot → clean install → build, then localize the
 *    failure with the SAME parser the gate uses, so the report names file:line, not soup.
 *
 * The point is leverage: a held build should explain itself in one command, not an hour.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Finding } from "../types.ts";
import { installStale } from "../gate/verify.ts";
import { parseBuildErrors } from "../gate/build-errors.ts";
import { packageNameOf } from "../autofix/missingdeps.ts";
import { DERIVED_DIRS } from "../gate/scan-scope.ts";

const DERIVED = new Set<string>(DERIVED_DIRS);
const SRC_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Every import/require specifier in a source file (bare + relative). */
const SPEC_RE = /(?:import[^'"]*?from|require\(|import\()\s*['"]([^'"]+)['"]/g;

function walkSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!DERIVED.has(e.name)) walk(join(dir, e.name));
      } else if (SRC_EXT.some((x) => e.name.endsWith(x))) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(root);
  return out;
}

/** Packages a source file imports that are NOT declared in package.json — the
 *  "imported but undeclared" class (e.g. `stripe`) the build fails on. */
export function detectUndeclaredImports(dir: string): string[] {
  const pkg = readJson(join(dir, "package.json")) ?? {};
  const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
  const missing = new Set<string>();
  for (const file of walkSources(dir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of content.matchAll(SPEC_RE)) {
      const name = packageNameOf(m[1] ?? "");
      if (name && !declared.has(name)) missing.add(name);
    }
  }
  return [...missing].sort();
}

export interface DepStatus {
  declared: number;
  nodeModulesPresent: boolean;
  lockfilePresent: boolean;
  installStale: boolean;
  undeclaredImports: string[];
  missingFromLock: string[];
}

export function depStatus(dir: string): DepStatus {
  const pkg = readJson(join(dir, "package.json")) ?? {};
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const lock = readJson(join(dir, "package-lock.json"));
  const lockPkgs = lock?.packages ?? {};
  const missingFromLock = Object.keys(declared).filter((name) => !(`node_modules/${name}` in lockPkgs)).sort();
  return {
    declared: Object.keys(declared).length,
    nodeModulesPresent: existsSync(join(dir, "node_modules")),
    lockfilePresent: existsSync(join(dir, "package-lock.json")),
    installStale: installStale(dir),
    undeclaredImports: detectUndeclaredImports(dir),
    missingFromLock: lock ? missingFromLock : [],
  };
}

export interface VibehardState {
  artifacts: string[];
  heldTicket: string | null;
}

export function readVibehardState(dir: string): VibehardState {
  const d = join(dir, ".vibehard");
  const artifacts: string[] = [];
  for (const a of ["spec", "prd", "srs", "architecture", "built"]) if (existsSync(join(d, `${a}.json`))) artifacts.push(a);
  let heldTicket: string | null = null;
  try {
    for (const f of readdirSync(d)) {
      if (f.startsWith("esc-") && f.endsWith(".json")) heldTicket = f.replace(/\.json$/, "");
    }
  } catch {
    /* no .vibehard */
  }
  return { artifacts, heldTicket };
}

/** Snapshot the source (no node_modules/.next), clean-install, build, and localize the
 *  failure. The slow tier — only when `--build` is passed. */
function buildCheck(dir: string): { ran: boolean; ok: boolean; findings: Finding[] } {
  let tmp: string;
  try {
    tmp = mkdtempSync(join(tmpdir(), "vibehard-diag-"));
  } catch {
    return { ran: false, ok: false, findings: [] };
  }
  try {
    cpSync(dir, tmp, { recursive: true, filter: (src) => !DERIVED.has(relative(dir, src).split("/").pop() ?? "") });
    const install = Bun.spawnSync(existsSync(join(tmp, "package-lock.json")) ? ["npm", "ci", "--no-audit", "--no-fund"] : ["npm", "install", "--no-audit", "--no-fund"], { cwd: tmp, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
    if ((install.exitCode ?? 1) !== 0) {
      const log = `${install.stdout?.toString() ?? ""}${install.stderr?.toString() ?? ""}`;
      const localized = parseBuildErrors(log, dir, "install-failed");
      return { ran: true, ok: false, findings: localized.length ? localized : [{ tool: "verify", ruleId: "install-failed", severity: "high", file: "package.json", message: `clean install failed — ${log.trim().slice(-400)}` }] };
    }
    const build = Bun.spawnSync(["npm", "run", "build"], { cwd: tmp, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
    if ((build.exitCode ?? 1) === 0) return { ran: true, ok: true, findings: [] };
    const log = `${build.stdout?.toString() ?? ""}${build.stderr?.toString() ?? ""}`;
    const localized = parseBuildErrors(log, dir);
    return { ran: true, ok: false, findings: localized.length ? localized : [{ tool: "verify", ruleId: "build-failed", severity: "high", file: "package.json", message: `build failed — ${log.trim().slice(-400)}` }] };
  } catch (e) {
    return { ran: true, ok: false, findings: [{ tool: "verify", ruleId: "build-failed", severity: "high", file: "package.json", message: String(e) }] };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export interface Diagnosis {
  dir: string;
  hasPackageJson: boolean;
  deps: DepStatus;
  state: VibehardState;
  build?: { ran: boolean; ok: boolean; findings: Finding[] };
}

export function diagnose(dir: string, opts: { build?: boolean } = {}): Diagnosis {
  const hasPackageJson = existsSync(join(dir, "package.json"));
  return {
    dir,
    hasPackageJson,
    deps: depStatus(dir),
    state: readVibehardState(dir),
    ...(opts.build && hasPackageJson ? { build: buildCheck(dir) } : {}),
  };
}

/** A compact human report — the thing printed by `vibehard diagnose`. */
export function formatDiagnosis(d: Diagnosis): string {
  const L: string[] = [];
  const ok = (b: boolean) => (b ? "✓" : "✗");
  L.push(`VibeHard diagnosis — ${d.dir}`);
  if (!d.hasPackageJson) {
    L.push("  (no package.json — not a node app)");
    return L.join("\n");
  }
  const dp = d.deps;
  L.push(`Dependencies: ${dp.declared} declared | node_modules ${ok(dp.nodeModulesPresent)} | lockfile ${ok(dp.lockfilePresent)} | install ${dp.installStale ? "STALE (deps changed since last install)" : "fresh"}`);
  L.push(`  imported but UNDECLARED: ${dp.undeclaredImports.length ? dp.undeclaredImports.join(", ") + "  ← add as dependencies" : "(none)"}`);
  L.push(`  declared but MISSING FROM LOCKFILE: ${dp.missingFromLock.length ? dp.missingFromLock.join(", ") + "  ← lockfile drift; npm install to resync" : "(none)"}`);
  L.push(`State (.vibehard): ${d.state.artifacts.length ? d.state.artifacts.map((a) => `${a}✓`).join(" ") : "(none)"}${d.state.heldTicket ? ` | held: ${d.state.heldTicket}` : ""}`);
  if (d.build) {
    if (!d.build.ran) L.push("Build: could not run");
    else if (d.build.ok) L.push("Build: ✓ clean install + build pass");
    else {
      L.push(`Build: ✗ FAILED — ${d.build.findings.length} localized finding(s):`);
      for (const f of d.build.findings) L.push(`  • ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message.replace(/^`npm run build` failed (at \S+ )?— /, "")}`);
    }
  }
  // headline verdict
  const codeErrors = d.build?.findings.filter((f) => f.file !== "package.json") ?? [];
  if (dp.undeclaredImports.length || dp.missingFromLock.length) L.push(`→ Dependency issue: ${[...dp.undeclaredImports, ...dp.missingFromLock].join(", ")} (deterministic fix).`);
  else if (codeErrors.length) L.push(`→ Code issue at ${codeErrors.map((f) => `${f.file}${f.line ? `:${f.line}` : ""}`).join(", ")} (LLM fix).`);
  else if (d.build?.ok) L.push("→ Clean.");
  else if (!d.build) L.push("→ Static checks clean. Re-run with --build for the build check.");
  return L.join("\n");
}
