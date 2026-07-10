/**
 * Deterministic merge for shared config files two concurrent codegen workstreams both write
 * (EPIC, found via dogfooding 2026-07-09 — ROADMAP.md "Parallel workstreams overwrite shared
 * config files"). `runTiers`/`pool.ts` runs up to `VIBEHARD_CODEGEN_CONCURRENCY` (default 4)
 * workstreams concurrently within a tier, each its own `BoltSession` materializing files with a
 * plain `Bun.write` — no merging, no locking. Confirmed live: two workstreams (`data-access`,
 * `tui-framework`) both wrote `package.json`; whichever finished last won outright, silently
 * discarding the other's dependencies/scripts and — the actual damage — reverting `main` from
 * the correct `src/index.js` back to a stale `dist/index.js`.
 *
 * These are pure functions (no I/O) — the write-side integration + concurrency lock live in
 * engine.ts, right next to the (structurally similar) hallucinated-lockfile guard.
 */

export interface MergeResult {
  merged: string;
  /** Human-readable notes about anything NOT silently resolved — surfaced as a message event,
   *  not guessed at. Empty when the merge was unambiguous (no overlapping keys, or overlapping
   *  keys agreed). */
  conflicts: string[];
}

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/**
 * Merge two `package.json` contents. `existing` is whatever an EARLIER-finishing workstream
 * already wrote to this path; `incoming` is what the current workstream is about to write.
 *
 * Policy, deliberately asymmetric per field class:
 *  - dependency maps + scripts: UNION (never silently drop a workstream's declared need);
 *    incoming wins on an exact key collision (both are just version ranges/commands — neither
 *    is "more correct" without semver-solving them, so last-declared is as good a rule as any).
 *  - `main`/`bin`: EXISTING WINS on a real conflict. This is the exact field that regressed in
 *    the confirmed incident — a later workstream silently reverted an earlier one's correct
 *    entry point. The first workstream to establish an entry point owns it; a conflicting later
 *    value is dropped and surfaced as a conflict, never silently applied.
 *  - everything else (name/version/type/private/license/engines/...): existing wins if present
 *    (first declaration is authoritative — these are almost always identical across workstreams
 *    anyway, e.g. every workstream declaring the same `type: "module"`), else take incoming's.
 *
 * Malformed JSON on either side fails toward PROGRESS, not toward blocking codegen entirely —
 * the verify/completeness gates downstream already catch a genuinely broken package.json; this
 * merge only needs to stop the SPECIFIC silent-overwrite failure mode.
 */
export function mergePackageJson(existingRaw: string, incomingRaw: string): MergeResult {
  let existing: Record<string, unknown>;
  let incoming: Record<string, unknown>;
  try {
    existing = JSON.parse(existingRaw) as Record<string, unknown>;
  } catch {
    return { merged: incomingRaw, conflicts: [] }; // existing unparsable → incoming is the best we have
  }
  try {
    incoming = JSON.parse(incomingRaw) as Record<string, unknown>;
  } catch {
    return { merged: existingRaw, conflicts: [] }; // incoming unparsable → keep the good one
  }

  const conflicts: string[] = [];
  const out: Record<string, unknown> = { ...existing };

  for (const key of DEP_FIELDS) {
    const e = asStringRecord(existing[key]);
    const i = asStringRecord(incoming[key]);
    if (Object.keys(e).length || Object.keys(i).length) out[key] = { ...e, ...i };
  }
  {
    const e = asStringRecord(existing.scripts);
    const i = asStringRecord(incoming.scripts);
    if (Object.keys(e).length || Object.keys(i).length) out.scripts = { ...e, ...i };
  }
  for (const key of ["main", "bin"] as const) {
    const e = existing[key];
    const i = incoming[key];
    if (i === undefined) continue;
    if (e === undefined) {
      out[key] = i;
    } else if (JSON.stringify(e) !== JSON.stringify(i)) {
      conflicts.push(`"${key}" — kept ${JSON.stringify(e)} (already declared), dropped conflicting ${JSON.stringify(i)}`);
    }
  }
  const HANDLED = new Set<string>([...DEP_FIELDS, "scripts", "main", "bin"]);
  for (const key of Object.keys(incoming)) {
    if (HANDLED.has(key) || key in out) continue;
    out[key] = incoming[key];
  }

  return { merged: `${JSON.stringify(out, null, 2)}\n`, conflicts };
}

function asStringRecord(v: unknown): Record<string, string> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
}

/**
 * Merge two `tsconfig.json` contents — the other shared file named in the same ROADMAP finding.
 * Lower-stakes than package.json (no equivalent of the main/bin regression is possible here —
 * `compilerOptions` entries are independent flags, not a single authoritative path), so this is
 * a flat union: `compilerOptions` keys merge (incoming wins on collision, same rationale as
 * scripts above), `include`/`exclude` arrays union with de-duplication, everything else existing-
 * wins-if-present else incoming, matching package.json's non-dependency fields.
 */
export function mergeTsconfig(existingRaw: string, incomingRaw: string): MergeResult {
  let existing: Record<string, unknown>;
  let incoming: Record<string, unknown>;
  try {
    existing = JSON.parse(existingRaw) as Record<string, unknown>;
  } catch {
    return { merged: incomingRaw, conflicts: [] };
  }
  try {
    incoming = JSON.parse(incomingRaw) as Record<string, unknown>;
  } catch {
    return { merged: existingRaw, conflicts: [] };
  }

  const out: Record<string, unknown> = { ...existing };
  const eOpts = (existing.compilerOptions && typeof existing.compilerOptions === "object" ? existing.compilerOptions : {}) as Record<string, unknown>;
  const iOpts = (incoming.compilerOptions && typeof incoming.compilerOptions === "object" ? incoming.compilerOptions : {}) as Record<string, unknown>;
  if (Object.keys(eOpts).length || Object.keys(iOpts).length) out.compilerOptions = { ...eOpts, ...iOpts };

  for (const key of ["include", "exclude"] as const) {
    const e = Array.isArray(existing[key]) ? (existing[key] as unknown[]) : [];
    const i = Array.isArray(incoming[key]) ? (incoming[key] as unknown[]) : [];
    if (e.length || i.length) out[key] = [...new Set([...e, ...i])];
  }
  for (const key of Object.keys(incoming)) {
    if (key === "compilerOptions" || key === "include" || key === "exclude" || key in out) continue;
    out[key] = incoming[key];
  }

  return { merged: `${JSON.stringify(out, null, 2)}\n`, conflicts: [] };
}

/** Basenames this merge logic applies to — the write-side chokepoint checks this, same pattern
 *  as engine.ts's LOCKFILE_BASENAMES. */
export const MERGEABLE_BASENAMES = new Set(["package.json", "tsconfig.json"]);

export function mergeConfigFile(basenameOf: string, existingRaw: string, incomingRaw: string): MergeResult {
  if (basenameOf === "package.json") return mergePackageJson(existingRaw, incomingRaw);
  if (basenameOf === "tsconfig.json") return mergeTsconfig(existingRaw, incomingRaw);
  return { merged: incomingRaw, conflicts: [] };
}
