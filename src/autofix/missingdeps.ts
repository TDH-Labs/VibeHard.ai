/**
 * Deterministic install of imported-but-UNDECLARED packages (the auto-fix loop's
 * other §11-deterministic strategy, alongside depbump). The verify gate fails the
 * build with "Module not found: Can't resolve 'stripe'" when the code imports a real
 * npm package that nobody added to package.json. Letting the fixer's LLM "add the
 * dependency" is unreliable — observed live: it added 3 of 4 missing deps, missed
 * one, and never synced package-lock.json, so `npm ci` (clean-room verify) kept
 * failing and the loop oscillated to a hold.
 *
 * The deterministic fix: parse the missing module name(s) straight from the gate
 * finding and `npm install` them. npm resolves the version from the registry (the
 * source of truth, exactly like trivy's "fixed in …" for depbump) and writes BOTH
 * package.json AND the lockfile in sync — closing the "declared but lockfile drifted"
 * failure mode at the same time. A name that doesn't resolve (a hallucinated import
 * that should be REMOVED from the code, not installed) simply fails its install and
 * is left for the LLM pass. §11 holds: deterministic installs what's real, the gate
 * re-verifies, the LLM only handles what's left.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";
import type { Finding } from "../types.ts";
import { safeToolEnv } from "../gate/verify.ts";
import { SUBPROCESS_TIMEOUT_MS } from "../util/timeouts.ts";

const BUILTINS = new Set<string>([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** Bare-specifier → package name: `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`. */
export function packageNameOf(spec: string): string | null {
  const s = spec.trim();
  if (!s) return null;
  if (s.startsWith(".") || s.startsWith("/")) return null; // relative/absolute path import
  if (s.startsWith("@/") || s.startsWith("~/")) return null; // tsconfig path alias, not a package
  if (s.startsWith("node:") || BUILTINS.has(s)) return null; // node builtin
  if (s.startsWith("@")) {
    const [scope, name] = s.split("/");
    // validate BOTH parts so `@org/..` (path-ish) can't slip through to the installer
    return scope && name && /^@[a-z0-9][a-z0-9._-]*$/i.test(scope) && /^[a-z0-9][a-z0-9._-]*$/i.test(name) ? `${scope}/${name}` : null;
  }
  const name = s.split("/")[0] ?? "";
  if (!name || BUILTINS.has(name)) return null;
  // a sane npm name: letters/digits/._- (scoped handled above)
  return /^[a-z0-9][a-z0-9._-]*$/i.test(name) ? name : null;
}

// webpack/Next.js say "…Can't resolve 'x'", node says "Cannot find module 'x'". Anchor
// on the word right before the quoted specifier (resolve/module) so an apostrophe earlier
// in the sentence ("Can't") can't derail the quote matching.
const RESOLVE_RE = /(?:resolve|module)\s+['"]([^'"]+)['"]/gi;

/** Pull the distinct, installable package names out of build/verify findings. */
export function parseMissingModules(findings: Finding[]): string[] {
  const out = new Set<string>();
  for (const f of findings) {
    if (f.tool !== "verify") continue; // only the build/clean-verify gate reports unresolved modules
    const msg = f.message ?? "";
    for (const m of msg.matchAll(RESOLVE_RE)) {
      const name = packageNameOf(m[1] ?? "");
      if (name) out.add(name);
    }
  }
  return [...out];
}

export interface MissingDepsResult {
  /** packages that installed cleanly (now in package.json + lockfile). */
  installed: string[];
  /** names that didn't resolve on the registry — likely hallucinated imports for the LLM/escalation. */
  failed: string[];
}

/**
 * Install each missing package, one at a time so one bogus name can't abort the rest.
 * `npm install pkg` adds it to package.json and regenerates the lockfile in sync.
 */
export function applyMissingDeps(workspacePath: string, packages: string[]): MissingDepsResult {
  const installed: string[] = [];
  const failed: string[] = [];
  if (!existsSync(join(workspacePath, "package.json"))) return { installed, failed: packages };
  for (const pkg of packages) {
    // --ignore-scripts (audit2 B-3): installing a missing/typosquatted dep must NOT run its
    // postinstall on the build host (which carries the operator's env). Resolve + place only.
    const r = Bun.spawnSync(["npm", "install", pkg, "--no-audit", "--no-fund", "--save", "--ignore-scripts"], {
      cwd: workspacePath,
      // audit3 M-1: scope the env — without this, npm inherits the FULL host process.env (FLY_API_TOKEN,
      // VIBEHARD_SECRETS_KEY, …) right inside the live build pipeline. safeToolEnv passes only toolchain
      // vars + the app's dummy keys (the same isolation the verify gate uses).
      env: safeToolEnv(workspacePath),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    });
    if ((r.exitCode ?? 1) === 0) installed.push(pkg);
    else failed.push(pkg);
  }
  return { installed, failed };
}
