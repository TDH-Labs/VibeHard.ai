/**
 * Deterministic dependency bumps for the auto-fix loop (PROJECT_BRIEF.md §15).
 * The fixed version comes from the GATE FINDING (trivy's "fixed in …"), NOT the
 * model — the model can't know post-cutoff versions; the gate-catch is the source
 * of truth. We bump to the highest SAME-MAJOR fix (a safe, non-breaking patch);
 * anything that only has a fix in a newer major is left for re-gate to surface and
 * the loop to escalate (we never auto-apply a breaking major upgrade).
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
  const safe = fixed.filter((v) => (parts(v)[0] ?? -2) === major && cmp(v, installed) > 0).sort(cmp);
  return safe.length ? safe[safe.length - 1]! : null;
}

export interface DepBumpResult {
  bumped: Array<{ pkg: string; from: string; to: string }>;
  /** packages whose only fix requires a major upgrade — left for the loop to escalate. */
  unfixable: string[];
  installExit: number | null;
}

/**
 * Bump vulnerable deps in package.json to safe same-major fixes (versions from the
 * trivy findings), then refresh the lockfile via `npm install` so the next trivy
 * scan (which reads the lock) sees the new versions. Pure-ish: the only I/O is the
 * package.json write + npm install.
 */
export function applyDepBumps(workspacePath: string, depFindings: Finding[]): DepBumpResult {
  const pkgPath = join(workspacePath, "package.json");
  if (!existsSync(pkgPath)) return { bumped: [], unfixable: [], installExit: null };

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return { bumped: [], unfixable: [], installExit: null };
  }

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
  const unfixable: string[] = [];
  for (const [pkgName, { installed, fixed }] of byPkg) {
    const target = pickBumpTarget(installed, [...fixed]);
    if (!target) {
      unfixable.push(pkgName);
      continue;
    }
    let changed = false;
    for (const dep of [pkg.dependencies, pkg.devDependencies]) {
      if (dep && pkgName in dep) {
        dep[pkgName] = target;
        changed = true;
      }
    }
    if (changed) bumped.push({ pkg: pkgName, from: installed, to: target });
  }

  if (!bumped.length) return { bumped, unfixable, installExit: null };

  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const install = Bun.spawnSync(["npm", "install", "--no-audit", "--no-fund"], {
    cwd: workspacePath,
    stdout: "ignore",
    stderr: "ignore",
  });
  return { bumped, unfixable, installExit: install.exitCode ?? 1 };
}
