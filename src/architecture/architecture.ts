/**
 * The Architecture — stage 3 of the front-half (PROJECT_BRIEF.md §22): the PRD
 * turned into a technical design the codegen builds from. It names the stack and the
 * WORKSTREAMS (components — each owns a set of files) and the dependency graph
 * between them. An LLM proposes it (architect.ts); this module is the deterministic
 * disposer:
 *   • `reviewArchitecture` — validate the graph (no cycles, no dangling deps, every
 *     workstream owns files) before anything is generated;
 *   • `buildOrder` — topologically sort the workstreams into TIERS. Within a tier the
 *     workstreams are independent (parallel-eligible); tiers are built in order
 *     (dependent ones after their deps). This is §22's "which are independent is
 *     deterministic from the plan" — the codegen then builds tier by tier.
 */
import type { Finding, GateVerdict } from "../types.ts";
import { verdictOf } from "../types.ts";
import type { Prd } from "../prd/index.ts";

/** One component of the app — owns files, may depend on other workstreams. */
export interface Workstream {
  name: string;
  responsibility: string;
  files: string[]; // the files this workstream generates (its slice of the package)
  dependsOn: string[]; // names of workstreams that must be built first
}

export interface Architecture {
  prd: Prd; // source, for traceability
  stack: string; // e.g. "Next.js + Supabase + TypeScript + Tailwind"
  workstreams: Workstream[];
}

const asStr = (v: unknown, d = ""): string => (typeof v === "string" ? v.trim() : d);
const asStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim()) : [];

/** Trust boundary: coerce the LLM's architecture JSON into a valid Architecture. */
export function coerceArchitecture(raw: unknown, prd: Prd): Architecture {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const workstreams = (Array.isArray(o.workstreams) ? o.workstreams : [])
    .map((w): Workstream | null => {
      if (!w || typeof w !== "object") return null;
      const wo = w as Record<string, unknown>;
      const name = asStr(wo.name);
      if (!name) return null;
      return { name, responsibility: asStr(wo.responsibility), files: asStrArr(wo.files), dependsOn: asStrArr(wo.dependsOn) };
    })
    .filter((w): w is Workstream => w !== null);
  return { prd, stack: asStr(o.stack, "unspecified"), workstreams };
}

/**
 * Pure: topologically sort workstreams into build tiers (Kahn's algorithm). Tier N
 * contains every workstream whose dependencies are all in tiers < N. A cycle leaves
 * workstreams unordered — `buildOrder` stops, and `reviewArchitecture` reports it.
 * Unknown dependencies are ignored here (also reported separately) so one bad edge
 * doesn't wedge the whole order.
 */
export function buildOrder(arch: Architecture): Workstream[][] {
  const byName = new Map(arch.workstreams.map((w) => [w.name, w]));
  const remaining = new Set(byName.keys());
  const done = new Set<string>();
  const tiers: Workstream[][] = [];

  while (remaining.size) {
    const ready = [...remaining].filter((n) => byName.get(n)!.dependsOn.every((d) => done.has(d) || !byName.has(d)));
    if (ready.length === 0) break; // no progress possible → cycle among the rest
    ready.sort(); // deterministic order within a tier
    for (const n of ready) {
      remaining.delete(n);
      done.add(n);
    }
    tiers.push(ready.map((n) => byName.get(n)!));
  }
  return tiers;
}

const gap = (ruleId: string, severity: Finding["severity"], message: string): Finding => ({
  tool: "architecture",
  ruleId,
  severity,
  file: "ARCHITECTURE",
  message,
});

/** Deterministic validation: the design must be buildable before codegen. */
export function reviewArchitecture(arch: Architecture): Finding[] {
  const out: Finding[] = [];
  if (arch.workstreams.length === 0) {
    out.push(gap("no-workstreams", "high", "The architecture defines no workstreams — there's nothing to build from."));
    return out;
  }
  const names = new Set(arch.workstreams.map((w) => w.name));
  for (const w of arch.workstreams) {
    if (w.files.length === 0) out.push(gap("workstream-no-files", "high", `Workstream "${w.name}" owns no files — it can't produce anything.`));
    for (const d of w.dependsOn) {
      if (!names.has(d)) out.push(gap("unknown-dependency", "high", `Workstream "${w.name}" depends on "${d}", which isn't a workstream.`));
    }
  }
  const ordered = buildOrder(arch).reduce((n, tier) => n + tier.length, 0);
  if (ordered < arch.workstreams.length) {
    out.push(gap("dependency-cycle", "high", "The workstream dependency graph has a cycle — it can't be built in a valid order."));
  }
  return out;
}

/** Gate-style verdict for architecture readiness (block iff a blocking gap). */
export function architectureVerdict(arch: Architecture, ranAt: string = new Date().toISOString()): GateVerdict {
  return verdictOf("architecture", reviewArchitecture(arch), ranAt);
}
