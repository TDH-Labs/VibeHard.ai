/**
 * Auto-fix loop (PROJECT_BRIEF.md §15 NEXT, §18). Makes "blocked" helpful:
 * gate → if blocked, fix → re-gate → bounded retries → escalate on exhaustion.
 * The GATE disposes (decides pass/fail), never the fixer/LLM (§11). Deterministic
 * control flow; the gate runner and fixer are injectable so the loop is unit-tested
 * without Docker or an LLM.
 */
import { isBlocking, type Finding, type Gate, type GateVerdict } from "../types.ts";
import { runGate, GATES, FAST_GATES, type PipelineResult } from "../gate/index.ts";
import { fastCheckVerdict, fastPreCheck } from "../gate/fast-checks.ts";
import { buildEscalationPacket, type EscalationPacket } from "../escalation/index.ts";
import { defaultFixer, type Fixer } from "./fixer.ts";
import { captureSurface, tamperReason } from "./anti-tamper.ts";
import { recordRound } from "../journal/journal.ts";
import { recordCandidate, recordResolution } from "../fleet/fleet.ts";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DERIVED_DIRS } from "../gate/scan-scope.ts";
import { pinDockerfileDigests } from "../gate/docker-pin.ts";

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
async function captureResolutions(ws: string, stack: string | undefined, prev: Finding[], currentSigs: Set<string>, preFixHashes: Map<string, string>): Promise<void> {
  if (!prev.length) return;
  const now = fileHashes(ws);
  const changed = [...now].filter(([p, h]) => preFixHashes.get(p) !== h).map(([p]) => p);
  for (const f of prev) {
    if (!currentSigs.has(sigOf(f))) await recordResolution(stack, sigOf(f), { message: f.message, files: changed });
  }
}

/** Resolves and rewrites the workspace Dockerfile's base-image digest(s) with the real,
 *  currently-published value — including replacing a fabricated one an LLM hand-wrote to
 *  satisfy prod-readiness's unpinned-base-image finding. Runs every round (cheap no-op once
 *  correct) so the gate and the deploy sandbox always see a resolvable FROM. */
async function normalizeDockerfile(workspacePath: string, note?: (m: string) => void): Promise<void> {
  for (const name of ["Dockerfile", "dockerfile"]) {
    const path = join(workspacePath, name);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, "utf8");
    const { content, changed, unresolved } = await pinDockerfileDigests(before);
    if (changed) writeFileSync(path, content);
    // Loud, not silent (2026-07-05): an unresolvable base ref means the prod-readiness pin
    // finding will persist and the fixer needs to pick a REAL published tag — say which ref.
    for (const ref of unresolved) note?.(`Dockerfile base image could not be resolved against its registry (${ref}) — the tag may not exist or the registry throttled; the digest pin was skipped this round`);
    return; // only one Dockerfile is expected per app (matches prod-readiness's readFirst)
  }
}

export type GateRunner = (workspacePath: string) => Promise<PipelineResult>;

export interface AutoFixOptions {
  gate?: GateRunner; // the inner-loop (fast) runner; default = FAST_GATES (cheap in-place verify)
  fullGate?: GateRunner; // the convergence (full) runner; default = GATES (real container verify)
  /** Runs BEFORE `gate` every round; default = fast-checks.ts's fastPreCheck (stray protocol
   *  artifacts, a bare `tsc --noEmit`, migration DDL against an embedded Postgres) — seconds, no
   *  Docker, no sandbox boot. A model-spontaneous bug that would fail the real gate chain anyway
   *  fails HERE first, so the loop doesn't pay a full round's cost just to learn that. Injectable
   *  for tests, same reason `gate`/`fullGate` are. */
  fastCheck?: GateRunner;
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
  /** Wall-clock ceiling on the WHOLE loop, independent of the attempt count (default 45 min).
   *  Every individual operation inside a round is itself bounded now (LLM calls: 240s +
   *  retry, generateTextResilient; subprocess calls: SUBPROCESS_TIMEOUT_MS, src/util/
   *  timeouts.ts) — but bounding every piece doesn't bound the WHOLE, and a slow-but-not-
   *  hung cascade (many rounds, each legitimately taking minutes) could still run far longer
   *  than reasonable. This is the outer safety net: if the loop is still going past this many
   *  ms, it stops and escalates through the SAME held-for-review path a normal stuck build
   *  already uses — self-healing by falling back to an existing, already-correct state,
   *  not a new failure mode. Found live 2026-07-09: a real build went silent for ~7 hours
   *  with zero forward progress and zero error. */
  maxDurationMs?: number;
  now?: string;
  onStep?: (msg: string) => void;
  /** build-substrate W3: called (and awaited) once per completed autofix iteration — the
   *  checkpoint boundary a BuildWorker uses to push workspace state to durable storage before
   *  continuing. Not called on the final round that reaches "gate green" (nothing left to
   *  checkpoint mid-loop at that point; the caller's own post-`autoFix` push covers it).
   *  Unset by every existing caller — a no-op, zero behavior change. */
  onRoundComplete?: (round: number) => void | Promise<void>;
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

/** Default outer wall-clock ceiling on the whole autoFix loop (see AutoFixOptions.maxDurationMs).
 *  45 minutes is generous for a real multi-round build with heavy fix rounds, and still finite. */
const DEFAULT_MAX_DURATION_MS = 45 * 60_000;

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

/** Apply the fixer, retrying the round ONCE on a throw. The driver already retries a transient
 *  stream stall internally, so a throw that reaches here is usually a brief provider outage — and
 *  since a stall is now caught by the idle watchdog (a throw, not a 12-min hang), it must not end
 *  the whole budget or force a human handoff over a 2-minute hiccup. A second failure rethrows, so
 *  the caller still escalates a genuinely-stuck fixer. */
async function applyFixWithRetry(fixer: Fixer, workspacePath: string, verdicts: GateVerdict[], note: (m: string) => void): Promise<void> {
  try {
    await fixer(workspacePath, verdicts);
  } catch (e) {
    note(`the fixer errored: ${e instanceof Error ? e.message : String(e)} — retrying the round once (often a transient stream stall)`);
    await fixer(workspacePath, verdicts); // a second throw propagates → the caller escalates
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
  const fastCheck: GateRunner =
    opts.fastCheck ??
    (async (p) => {
      const r = await fastPreCheck(p);
      return r.passed ? { passed: true, verdicts: [] } : { passed: false, verdicts: [fastCheckVerdict(r.findings, new Date().toISOString())] };
    });
  // Three tiers now, cheapest first: fastCheck (seconds, no Docker) → gate (cheap in-place build)
  // → fullGate (real container verify), CONFIRMED only when everything cheaper already passed —
  // so a reported "pass" is always a TRUE pass, and a doomed round fails at the cheapest tier
  // that can already tell.
  const gateConfirmed: GateRunner = async (p) => {
    const pre = await fastCheck(p);
    if (!pre.passed) return pre;
    const r = await gate(p);
    return r.passed ? await fullGate(p) : r;
  };
  const fixer: Fixer = opts.fixer ?? defaultFixer();
  const nte = opts.budget ?? defaultBudgetFor(workspacePath);
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const startedAt = Date.now();
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
  let tampered: string | null = null; // set if a fix cleared a gate by removing protected surface
  let lastVerdicts: GateVerdict[] = []; // the real findings to escalate against on a tamper-reject
  let prevCount = Infinity;
  let noProgress = 0;
  let attempts = 0;
  let stopReason = `reached the ${nte}-attempt ceiling`;

  while (attempts < nte) {
    // Outer wall-clock ceiling, independent of the attempt count — every operation inside a
    // round is itself bounded now (LLM calls, subprocess calls), but bounding every piece
    // doesn't bound the WHOLE loop; a slow-but-not-hung cascade could still run unreasonably
    // long. Checked at the top of every round, same place the other stuck-detectors live.
    if (Date.now() - startedAt > maxDurationMs) {
      stopReason = `exceeded the ${Math.round(maxDurationMs / 60_000)}-minute wall-clock ceiling (${attempts} attempt(s) so far)`;
      note(`${stopReason}; escalating`);
      break;
    }
    // Deterministic normalization before the gate ever looks: a hand-written or fabricated
    // base-image digest gets replaced with the real one here, so neither the gate nor the
    // deploy sandbox ever has to deal with a FROM line that can't resolve.
    await normalizeDockerfile(workspacePath, note);
    // FAST inner loop (cheap verify proxy); a pass is confirmed by the full suite ONCE — the
    // human-engineer pattern: iterate cheap, verify full only at convergence.
    const r = await gateConfirmed(workspacePath);
    if (r.passed) {
      await captureResolutions(workspacePath, fleetStack, prevBlocking, new Set(), preFixHashes);
      note(`gate green (full verification) after ${attempts} fix attempt(s)`);
      return { fixed: true, attempts, finalVerdicts: r.verdicts, escalation: null, log };
    }

    const blocking = r.verdicts.flatMap((v) => v.findings).filter(isBlocking);
    const currentSigs = new Set(blocking.map(sigOf));
    await captureResolutions(workspacePath, fleetStack, prevBlocking, currentSigs, preFixHashes); // what the last fix cleared
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
        await recordCandidate(fleetStack, sig, fleetAppId);
      }
    }
    note(`attempt ${attempts}/${nte}: blocked by ${blocked} — applying fixes`);
    preFixHashes = fileHashes(workspacePath); // snapshot so the NEXT gate can attribute what this fix cleared
    prevBlocking = blocking;
    lastVerdicts = r.verdicts; // escalate against the REAL findings if the fix turns out to be tampering
    const beforeSurface = captureSurface(workspacePath, blocking); // protected surface that must not shrink
    try {
      await applyFixWithRetry(fixer, workspacePath, r.verdicts, note);
    } catch (e) {
      stopReason = `the fixer errored twice: ${e instanceof Error ? e.message : String(e)}`;
      note(`${stopReason} — escalating`);
      break;
    }
    // ANTI-TAMPER (audit CRITICAL-1): a fix may not clear a gate by deleting the flagged file/table.
    // If it shrank protected surface, REJECT the round and escalate — a gamed green is never accepted.
    tampered = tamperReason(beforeSurface, captureSurface(workspacePath, blocking));
    if (tampered) {
      stopReason = `fix REJECTED as tampering — ${tampered}`;
      note(`${stopReason}; escalating (a gate made green by removing protected code is not a fix)`);
      break;
    }
    // build-substrate W3: one autofix iteration just completed (fix applied, anti-tamper
    // passed) — the natural checkpoint boundary for a BuildWorker running this loop inside an
    // isolated sandbox. Awaited: a checkpoint push failure must hold the round here, not let
    // the loop silently continue past unsaved progress (PRD AC1.2 / SPEC decision #4). A
    // no-op when nothing is injected (every existing caller of autoFix — unchanged).
    await opts.onRoundComplete?.(attempts);
  }

  // A TAMPERED round never gets to claim a pass — skip the re-gate (the tamper may have greened it) and
  // escalate the REAL findings the fixer was supposed to resolve. Fail closed against a gamed verifier.
  if (tampered) {
    note(`escalating — ${stopReason}`);
    const escalation = await buildEscalationPacket(lastVerdicts, workspacePath, { reason: `auto-fix rejected a tampering fix: ${stopReason}`, now: opts.now });
    return { fixed: false, attempts, finalVerdicts: lastVerdicts, escalation, log };
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
    let ceilingHit = false;
    for (let i = 0; i < extra; i++) {
      // Same outer ceiling as the main loop — this extension phase is exactly where the
      // live 2026-07-09 incident was sitting when it went silent, and it had no wall-clock
      // check of its own at all.
      if (Date.now() - startedAt > maxDurationMs) {
        ceilingHit = true;
        stopReason = `exceeded the ${Math.round(maxDurationMs / 60_000)}-minute wall-clock ceiling during extension attempts (${attempts} attempt(s) so far)`;
        note(`${stopReason}; stopping`);
        break;
      }
      attempts++;
      const extraBlocking = final.verdicts.flatMap((v) => v.findings).filter(isBlocking);
      const blocked = final.verdicts.filter((v) => v.status === "block").map((v) => `${v.gate}(${v.blocking})`).join(", ");
      note(`extra attempt ${i + 1}/${extra} (no human): blocked by ${blocked} — applying fixes`);
      // Found live 2026-07-05: these extension rounds applied fixes with NO anti-tamper check —
      // a fixer could shrink protected surface (drop a table, neuter a property test) here and a
      // green re-gate would be ACCEPTED. The extension must be exactly as strict as the main
      // loop: capture the surface, reject a shrinking fix, escalate against the REAL verdicts.
      const beforeExtraSurface = captureSurface(workspacePath, extraBlocking);
      try {
        await applyFixWithRetry(fixer, workspacePath, final.verdicts, note);
      } catch (e) {
        note(`fixer errored twice: ${e instanceof Error ? e.message : String(e)} — stopping extra attempts`);
        break;
      }
      const extraTamper = tamperReason(beforeExtraSurface, captureSurface(workspacePath, extraBlocking));
      if (extraTamper) {
        note(`fix REJECTED as tampering — ${extraTamper}`);
        stopReason = `${stopReason}; an extension-round fix was rejected as tampering (${extraTamper})`;
        break; // escalate with `final` — the real, pre-tamper verdicts
      }
      // Same deterministic normalization the main loop applies before every gate look (the
      // extension skipping it left fixer-rewritten Dockerfiles unpinned through final verdicts).
      await normalizeDockerfile(workspacePath, note);
      // build-substrate W3: this extension phase used to be the ONE place in the whole loop
      // that never checkpointed — found live 2026-07-12 while verifying multi-round behavior
      // before a real test, not by a failure. A BuildWorker running a build that reaches here
      // (main budget exhausted, no human available) would go up to 5 more rounds with no
      // incremental Tigris push and no stop-check ping — a stop wouldn't be honored until the
      // whole extension phase finished, and a sandbox death mid-extension would lose those
      // rounds' progress (though never the LAST successfully-checkpointed state — finalPush()
      // still runs regardless of where the loop exits). Same call, same placement as the main
      // loop's, so the extension is checkpointed exactly as strictly as everywhere else.
      await opts.onRoundComplete?.(attempts);
      final = await gateConfirmed(workspacePath);
      if (final.passed) {
        note(`gate green after ${attempts} fix attempt(s) (no-human extension)`);
        return { fixed: true, attempts, finalVerdicts: final.verdicts, escalation: null, log };
      }
    }
    if (!ceilingHit && !stopReason.includes("tampering")) stopReason = `${stopReason}; ${extra} extra no-human attempt(s) also failed`;
  }

  note(`escalating residual findings — ${stopReason}`);
  const escalation = await buildEscalationPacket(final.verdicts, workspacePath, {
    reason: `auto-fix escalated: ${stopReason}`,
    now: opts.now,
  });
  return { fixed: false, attempts, finalVerdicts: final.verdicts, escalation, log };
}
