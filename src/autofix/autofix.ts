/**
 * Auto-fix loop (PROJECT_BRIEF.md §15 NEXT, §18). Makes "blocked" helpful:
 * gate → if blocked, fix → re-gate → bounded retries → escalate on exhaustion.
 * The GATE disposes (decides pass/fail), never the fixer/LLM (§11). Deterministic
 * control flow; the gate runner and fixer are injectable so the loop is unit-tested
 * without Docker or an LLM.
 */
import { isBlocking, type Finding, type Gate } from "../types.ts";
import { runGate, GATES, FAST_GATES, type PipelineResult } from "../gate/index.ts";
import { buildEscalationPacket, type EscalationPacket } from "../escalation/index.ts";
import { defaultFixer, type Fixer } from "./fixer.ts";
import { recordRound } from "../journal/journal.ts";
import { recordCandidate, recordResolution } from "../fleet/fleet.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { DERIVED_DIRS } from "../gate/scan-scope.ts";

const DERIVED = new Set<string>(DERIVED_DIRS);
const sigOf = (f: Finding): string => `${f.tool}:${f.ruleId}`;

/** Read the build's stack from its architecture.json, to scope fleet candidates. */
function workspaceStack(ws: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(ws, ".vibehard", "architecture.json"), "utf8")) as { stack?: string }).stack;
  } catch {
    return undefined;
  }
}

/** A stable id for THIS app (its spec name) — so the fleet can count DISTINCT apps a failure hit
 *  (diversity), not just occurrences. Same app retried ≠ a universal signal. */
function workspaceAppId(ws: string): string | undefined {
  try {
    const name = (JSON.parse(readFileSync(join(ws, ".vibehard", "spec.json"), "utf8")) as { name?: string }).name;
    return name ? name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : undefined;
  } catch {
    return undefined;
  }
}

/** Content hashes of authored source — to see which files a fix changed (fix-capture). */
function fileHashes(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!DERIVED.has(e.name)) walk(abs);
      } else if (/\.(tsx?|jsx?|mjs|cjs|css|json)$/.test(e.name)) {
        try {
          out.set(relative(root, abs), Bun.hash(readFileSync(abs)).toString());
        } catch {
          /* unreadable → skip */
        }
      }
    }
  };
  walk(root);
  return out;
}

/** KEYSTONE OF INDUCTION: a finding present before a fix and GONE after = the fix cleared it
 *  (verifier-gated). Record the (failure → the files that changed) pair as fleet evidence. */
function captureResolutions(ws: string, stack: string | undefined, prev: Finding[], currentSigs: Set<string>, preFixHashes: Map<string, string>): void {
  if (!prev.length) return;
  const now = fileHashes(ws);
  const changed = [...now].filter(([p, h]) => preFixHashes.get(p) !== h).map(([p]) => p);
  for (const f of prev) {
    if (!currentSigs.has(sigOf(f))) recordResolution(stack, sigOf(f), { message: f.message, files: changed });
  }
}

export type GateRunner = (workspacePath: string) => Promise<PipelineResult>;

export interface AutoFixOptions {
  gate?: GateRunner; // the inner-loop (fast) runner; default = FAST_GATES (cheap in-place verify)
  fullGate?: GateRunner; // the convergence (full) runner; default = GATES (real container verify)
  gates?: Gate[];
  fixer?: Fixer;
  /** Max fix→re-gate cycles before escalating (§18 retry budget). */
  budget?: number;
  /** Whether a human can take an escalation right now. When provided and it returns
   *  false, the loop runs `extraBudgetNoHuman` MORE raw attempts before holding — so a
   *  build never just HANGS in the queue waiting for an absent reviewer. */
  humanAvailable?: () => boolean | Promise<boolean>;
  /** Extra fix attempts when no human is available (default 5). */
  extraBudgetNoHuman?: number;
  now?: string;
  onStep?: (msg: string) => void;
}

export interface AutoFixResult {
  fixed: boolean;
  attempts: number;
  finalVerdicts: PipelineResult["verdicts"];
  /** Set when the budget is exhausted with the gate still blocking. */
  escalation: EscalationPacket | null;
  log: string[];
}

/** NTE — the hard not-to-exceed on fix→re-gate cycles. A ceiling on purpose: every loop is real
 *  wall-clock + token spend, so this caps maximum exposure. Progress-based stopping (below) usually
 *  exits earlier — converged, or escalated because it's stuck — so this only bites a slow-but-
 *  converging cascade, where the headroom is cheap insurance against clipping a fix still landing. */
const DEFAULT_BUDGET = 10;

/** The budget must SCALE with how many features the build owes: the completeness gate makes the
 *  loop build one missing feature per round, and each feature is ~1 build round + ~1 round to fix
 *  the build errors it introduces. A flat 10 can't build a 10-feature app one-at-a-time (it ran
 *  dry at 7/10). So: base (general fixes) + 2 per spec feature. Still a not-to-exceed — the
 *  progress detectors stop a stuck build long before this. */
export function defaultBudgetFor(workspacePath: string): number {
  try {
    const spec = JSON.parse(readFileSync(join(workspacePath, ".vibehard", "spec.json"), "utf8")) as { features?: unknown[] };
    const n = Array.isArray(spec.features) ? spec.features.length : 0;
    return DEFAULT_BUDGET + 2 * n;
  } catch {
    return DEFAULT_BUDGET; // no spec (didn't go through planning) → the flat base
  }
}

/** Stable identity of a finding, for round-over-round progress + cycle detection. */
function fingerprint(f: Finding): string {
  return `${f.tool}:${f.ruleId}:${f.file}:${f.line ?? "?"}`;
}

export async function autoFix(workspacePath: string, opts: AutoFixOptions = {}): Promise<AutoFixResult> {
  // Fast inner loop (verify = cheap in-place build), full verification ONCE at convergence.
  const gate: GateRunner = opts.gate ?? ((p) => runGate(p, opts.gates ?? FAST_GATES));
  const fullGate: GateRunner = opts.fullGate ?? opts.gate ?? ((p) => runGate(p, opts.gates ?? GATES));
  // The cheap inner gate, then CONFIRM with the full suite when it passes — so a reported "pass"
  // is always a TRUE pass (the full verifier still gates it; the proxy only speeds iteration).
  const gateConfirmed: GateRunner = async (p) => {
    const r = await gate(p);
    return r.passed ? await fullGate(p) : r;
  };
  const fixer: Fixer = opts.fixer ?? defaultFixer();
  const nte = opts.budget ?? defaultBudgetFor(workspacePath);
  const log: string[] = [];
  const note = (m: string): void => {
    log.push(m);
    opts.onStep?.(m);
  };

  // Loop while it's WINNING (the blocking set strictly shrinks), up to the NTE ceiling.
  // Escalate EARLY when stuck rather than burning the whole budget on a wall:
  //   • cycle / no-change — the exact blocking set recurs (a fix changed nothing or oscillated);
  //   • plateau — 2 consecutive rounds without the blocking set getting smaller.
  // The GATE still disposes every round (§11); this only decides when to stop trying.
  const seen = new Set<string>(); // blocking-set signatures already encountered
  const fleetStack = workspaceStack(workspacePath); // for scoping fleet candidates
  const fleetAppId = workspaceAppId(workspacePath); // for diversity (distinct apps a failure hit)
  const recordedSignals = new Set<string>(); // fleet candidates recorded ONCE per build, not per round
  let prevBlocking: Finding[] = []; // findings before the last fix — to attribute what that fix cleared
  let preFixHashes = new Map<string, string>(); // source before the last fix
  let prevCount = Infinity;
  let noProgress = 0;
  let attempts = 0;
  let stopReason = `reached the ${nte}-attempt ceiling`;

  while (attempts < nte) {
    // FAST inner loop (cheap verify proxy); a pass is confirmed by the full suite ONCE — the
    // human-engineer pattern: iterate cheap, verify full only at convergence.
    const r = await gateConfirmed(workspacePath);
    if (r.passed) {
      captureResolutions(workspacePath, fleetStack, prevBlocking, new Set(), preFixHashes);
      note(`gate green (full verification) after ${attempts} fix attempt(s)`);
      return { fixed: true, attempts, finalVerdicts: r.verdicts, escalation: null, log };
    }

    const blocking = r.verdicts.flatMap((v) => v.findings).filter(isBlocking);
    const currentSigs = new Set(blocking.map(sigOf));
    captureResolutions(workspacePath, fleetStack, prevBlocking, currentSigs, preFixHashes); // what the last fix cleared
    const signature = blocking.map(fingerprint).sort().join("|");
    const blocked = r.verdicts.filter((v) => v.status === "block").map((v) => `${v.gate}(${v.blocking})`).join(", ");

    // stuck #1 — the same blocking set already occurred → looping won't converge.
    if (seen.has(signature)) {
      stopReason = `no progress — the same ${blocking.length} blocking finding(s) recurred (a fix changed nothing or oscillated)`;
      note(`${stopReason}; escalating early`);
      break;
    }
    // stuck #2 — three consecutive rounds without the blocking set shrinking. (Batched
    // tsc fixing clears many errors per round, so real progress shows as a dropping count;
    // allow one extra flat round before giving up vs. the old 2, since a round that swaps
    // one localized error for the next is still forward motion on a big app's tail.)
    noProgress = blocking.length < prevCount ? 0 : noProgress + 1;
    if (noProgress >= 3) {
      stopReason = `no progress for 3 rounds (still ${blocking.length} blocking)`;
      note(`${stopReason}; escalating early`);
      break;
    }

    seen.add(signature);
    prevCount = blocking.length;
    attempts++;
    recordRound(workspacePath, attempts, blocked, blocking); // as-built journal: what this round faced
    for (const f of blocking) {
      // fleet learning: which gate failures this build hit — recorded ONCE per build per signal.
      const sig = `${f.tool}:${f.ruleId}`;
      if (!recordedSignals.has(sig)) {
        recordedSignals.add(sig);
        recordCandidate(fleetStack, sig, fleetAppId);
      }
    }
    note(`attempt ${attempts}/${nte}: blocked by ${blocked} — applying fixes`);
    preFixHashes = fileHashes(workspacePath); // snapshot so the NEXT gate can attribute what this fix cleared
    prevBlocking = blocking;
    try {
      await fixer(workspacePath, r.verdicts);
    } catch (e) {
      stopReason = `the fixer errored: ${e instanceof Error ? e.message : String(e)}`;
      note(`${stopReason} — escalating`);
      break;
    }
  }

  // Final disposition (a fix may have landed in the last iteration → re-gate to be sure).
  let final = await gateConfirmed(workspacePath);
  if (final.passed) {
    note(`gate green after ${attempts} fix attempt(s)`);
    return { fixed: true, attempts, finalVerdicts: final.verdicts, escalation: null, log };
  }

  // Would hand off to a human — but if NONE is available, keep trying rather than leave
  // the build hanging in the queue. Up to `extraBudgetNoHuman` more raw attempts (no
  // early-stuck-exit; the LLM is stochastic, so a retry can land what a stuck round
  // couldn't). If those also fail, hold anyway — fail-closed, just with more effort spent.
  const extra = opts.extraBudgetNoHuman ?? 5;
  if (extra > 0 && opts.humanAvailable && !(await opts.humanAvailable())) {
    note(`no human available — continuing up to ${extra} more attempt(s) to self-resolve`);
    for (let i = 0; i < extra; i++) {
      attempts++;
      const blocked = final.verdicts.filter((v) => v.status === "block").map((v) => `${v.gate}(${v.blocking})`).join(", ");
      note(`extra attempt ${i + 1}/${extra} (no human): blocked by ${blocked} — applying fixes`);
      try {
        await fixer(workspacePath, final.verdicts);
      } catch (e) {
        note(`fixer errored: ${e instanceof Error ? e.message : String(e)} — stopping extra attempts`);
        break;
      }
      final = await gateConfirmed(workspacePath);
      if (final.passed) {
        note(`gate green after ${attempts} fix attempt(s) (no-human extension)`);
        return { fixed: true, attempts, finalVerdicts: final.verdicts, escalation: null, log };
      }
    }
    stopReason = `${stopReason}; ${extra} extra no-human attempt(s) also failed`;
  }

  note(`escalating residual findings — ${stopReason}`);
  const escalation = await buildEscalationPacket(final.verdicts, workspacePath, {
    reason: `auto-fix escalated: ${stopReason}`,
    now: opts.now,
  });
  return { fixed: false, attempts, finalVerdicts: final.verdicts, escalation, log };
}
