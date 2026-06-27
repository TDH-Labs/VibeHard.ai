/**
 * Deterministic dependency bumps for the auto-fix loop (PROJECT_BRIEF.md §15).
 * The fixed version comes from the GATE FINDING (trivy's "fixed in …"), NOT the
 * model — the model can't know post-cutoff versions; the gate-catch is the source
 * of truth. A same-major fix is a safe, non-breaking bump. When a CVE is only fixed
 * in a NEWER major, we ALSO apply that major bump (still deterministic — version from
 * the finding) and hand it to the fixer's LLM to adapt the code to the breaking
 * changes; the GATE then verifies the result. §11 holds: deterministic picks the
 * version, the LLM only adapts, the gate disposes. Escalation is for when that can't
 * converge — not a reflex on every breaking change.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../types.ts";

/** Parse `pkg@installed: <title> (fixed in a, b, c)` from a trivy Finding message. */
export function parseDepFinding(f: Finding): { pkg: string; installed: string; fixed: string[] } | null {
  const m = /^(\S+)@(\S+?):\s.*\(fixed in ([^)]+)\)\s*$/.exec(f.message);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const fixed = m[3].split(",").map((s) => s.trim()).filter(Boolean);
  return { pkg: m[1], installed: m[2], fixed };
}

function parts(v: string): number[] {
  return v.replace(/^[^\d]*/, "").split(".").map((n) => parseInt(n, 10) || 0);
}
/** semver-ish compare (major.minor.patch; pre-release ignored). */
function cmp(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Highest fixed version that shares `installed`'s major and is greater than it —
 * a safe in-major bump. null when every fix needs a major upgrade (→ escalate,
 * don't auto-break the app).
 */
export function pickBumpTarget(installed: string, fixed: string[]): string | null {
  const major = parts(installed)[0] ?? -1;
  const safe = fixed.filter((v) => !v.includes("-") && (parts(v)[0] ?? -2) === major && cmp(v, installed) > 0).sort(cmp);
  return safe.length ? safe[safe.length - 1]! : null;
}

/**
 * The BREAKING fallback (used only when there's no same-major fix): the highest STABLE
 * version in the LOWEST major above `installed`'s. Minimal jump — one major at a time, so
 * a remaining higher-major CVE just re-surfaces next round and bumps again. null when no
 * higher-major fix exists (pre-releases/canaries ignored).
 */
export function pickMajorTarget(installed: string, fixed: string[]): string | null {
  const major = parts(installed)[0] ?? -1;
  const higher = fixed.filter((v) => !v.includes("-") && (parts(v)[0] ?? -2) > major);
  if (!higher.length) return null;
  const lowestHigherMajor = Math.min(...higher.map((v) => parts(v)[0]!));
  const inThatMajor = higher.filter((v) => parts(v)[0] === lowestHigherMajor).sort(cmp);
  return inThatMajor[inThatMajor.length - 1]!;
}

export interface DepBumpResult {
  bumped: Array<{ pkg: string; from: string; to: string }>; // safe same-major bumps (direct deps)
  /** breaking MAJOR bumps applied — the fixer's LLM must adapt the code; the gate verifies. */
  majorBumped: Array<{ pkg: string; from: string; to: string }>;
  /** TRANSITIVE deps (nested inside another package, not on the dependency list) forced to a
   *  patched version via an npm `overrides` entry — the only way to patch a CVE deep in the tree. */
  overridden: Array<{ pkg: string; from: string; to: string }>;
  /** packages with no usable fix at all (rare) — nothing to bump to. */
  unfixable: string[];
  installExit: number | null;
}

type PkgManifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; overrides?: Record<string, string> };

/**
 * Pure: decide + apply the package.json mutations for a set of dep findings (mutates `pkg` in
 * place; the caller owns the read/write). A DIRECT dependency (in dependencies/devDependencies) is
 * bumped in its entry; a TRANSITIVE one (nested inside another package, so not on the list) is
 * forced via an npm `overrides` entry — the only way to patch a CVE deep in the tree without
 * waiting on the parent to update. No I/O → unit-testable. The version comes from the gate finding.
 */
export function planDepBumps(pkg: PkgManifest, depFindings: Finding[]): Omit<DepBumpResult, "installExit"> {
  // Group findings by package → union of all its fixed versions.
  const byPkg = new Map<string, { installed: string; fixed: Set<string> }>();
  for (const f of depFindings) {
    const p = parseDepFinding(f);
    if (!p) continue;
    const e = byPkg.get(p.pkg) ?? { installed: p.installed, fixed: new Set<string>() };
    for (const v of p.fixed) e.fixed.add(v);
    byPkg.set(p.pkg, e);
  }

  const bumped: DepBumpResult["bumped"] = [];
  const majorBumped: DepBumpResult["majorBumped"] = [];
  const overridden: DepBumpResult["overridden"] = [];
  const unfixable: string[] = [];
  for (const [pkgName, { installed, fixed }] of byPkg) {
    const fixedArr = [...fixed];
    const inMajor = pickBumpTarget(installed, fixedArr);
    const target = inMajor ?? pickMajorTarget(installed, fixedArr); // breaking fallback when no same-major fix
    if (!target) {
      unfixable.push(pkgName);
      continue;
    }
    let direct = false;
    for (const dep of [pkg.dependencies, pkg.devDependencies]) {
      if (dep && pkgName in dep) {
        dep[pkgName] = target;
        direct = true;
      }
    }
    if (direct) {
      (inMajor ? bumped : majorBumped).push({ pkg: pkgName, from: installed, to: target });
    } else {
      // Transitive: force the patched version via an npm override (prefer the same-major fix so
      // the parent keeps working; the gate re-verifies regardless).
      pkg.overrides = pkg.overrides ?? {};
      pkg.overrides[pkgName] = target;
      overridden.push({ pkg: pkgName, from: installed, to: target });
    }
  }
  return { bumped, majorBumped, overridden, unfixable };
}

/**
 * Apply the dep bumps to package.json, then refresh the lockfile via `npm install` so the next
 * trivy scan (which reads the lock) sees the new versions. Direct deps are bumped in place;
 * transitive ones are forced via `overrides`. §11: the version comes from the gate finding, and
 * the gate re-verifies. The only I/O is the package.json write + npm install.
 */
export function applyDepBumps(workspacePath: string, depFindings: Finding[]): DepBumpResult {
  const empty: DepBumpResult = { bumped: [], majorBumped: [], overridden: [], unfixable: [], installExit: null };
  const pkgPath = join(workspacePath, "package.json");
  if (!existsSync(pkgPath)) return empty;

  let pkg: PkgManifest;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return empty;
  }

  const plan = planDepBumps(pkg, depFindings);
  if (!plan.bumped.length && !plan.majorBumped.length && !plan.overridden.length) return { ...plan, installExit: null };

  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const install = Bun.spawnSync(["npm", "install", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: workspacePath,
    stdout: "ignore",
    stderr: "ignore",
  });
  return { ...plan, installExit: install.exitCode ?? 1 };
}
