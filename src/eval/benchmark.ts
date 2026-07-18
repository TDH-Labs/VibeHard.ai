/**
 * The ship-rate BENCHMARK (Phase 2, EPIC #38) — the only success criterion that counts:
 * of 10 fixed, diverse prompts, how many produce a LIVE, LOADABLE, GATE-GREEN DEPLOYED app
 * with zero human intervention? (`runEval`/harness.ts scores gate-pass of a workspace; this
 * measures the full outcome: build → auto-fix → gates green → ship → the URL answers 200.)
 *
 * Everything expensive is injected (build/ship/probe), so the orchestration + the log parsing
 * are unit-tested with zero token spend. The log parsers read the CLI's machine-parseable
 * markers ("::held <ticket>", "gate: ✗ <name>", "auto-fix attempt(s)") — the same shapes the
 * web dashboard already keys on, so they are load-bearing output, not incidental formatting.
 *
 * Every run's per-case record is the input to eval/LEDGER.md — the failure-class taxonomy that
 * IS the unknown-unknowns discovery mechanism. The runner records; a person (or a later
 * session) classifies and root-causes. Never classify automatically what hasn't been diagnosed.
 */

export interface BenchCase {
  id: string;
  prompt: string;
  /** Extra env for this case's build (e.g. VIBEHARD_LANG=python for the FastAPI case). */
  env?: Record<string, string>;
}

export type BenchOutcome =
  | "shipped" //       gates green, deployed, URL answered 2xx — the ONLY outcome that scores
  | "held" //          auto-fix exhausted, held for human review
  | "build-failed" //   the pipeline itself failed before/at gating (no hold ticket)
  | "ship-failed" //    gates green but the deploy step failed
  | "not-loadable"; //  deployed but the URL never answered 2xx

export interface BenchResult {
  id: string;
  outcome: BenchOutcome;
  /** gates that were blocking at the END of the build (parsed from the final gate summary) */
  blockingGates: string[];
  /** auto-fix attempts the build reported (null when the marker never appeared) */
  attempts: number | null;
  /** hold ticket id when held */
  ticket: string | null;
  wallClockMs: number;
  url: string | null;
  probeStatus: number | null;
  /** tail of the build/ship log for the ledger entry (never the whole log) */
  logTail: string;
}

export interface BenchReport {
  results: BenchResult[];
  total: number;
  shipped: number;
  /** shipped / total — THE score. */
  score: number;
}

/** Parse the hold ticket from a build log ("::held esc-4836pb"). */
export function parseHeldTicket(log: string): string | null {
  const m = /^\s*::held\s+(\S+)/m.exec(log);
  return m ? m[1]! : null;
}

/** Parse auto-fix attempts ("auto-fix could not resolve everything in 4 attempt(s)" /
 *  "gate green after 2 auto-fix attempt(s)"). */
export function parseAttempts(log: string): number | null {
  const m = /(\d+)\s+auto-fix attempt\(s\)/.exec(log) ?? /in\s+(\d+)\s+attempt\(s\)/.exec(log);
  return m ? Number(m[1]) : null;
}

/** Parse the FINAL gate summary's blocking gates ("gate: ✗ verify (2 blocking)") — the last
 *  contiguous gate block in the log, since the fix loop prints one summary per round. */
export function parseFinalBlockingGates(log: string): string[] {
  const rounds: string[][] = [];
  let current: string[] | null = null;
  for (const line of log.split("\n")) {
    const g = /^\s*gate: (.) (\S+)/.exec(line);
    if (!g) {
      if (current) rounds.push(current);
      current = null;
      continue;
    }
    current ??= [];
    if (g[1] === "✗") current.push(g[2]!);
  }
  if (current) rounds.push(current);
  return rounds.length ? rounds[rounds.length - 1]! : [];
}

/** Parse the shipped URL from `vibehard ship` output (first https://…). */
export function parseShipUrl(log: string): string | null {
  const m = /https:\/\/[^\s"')]+/.exec(log);
  return m ? m[0] : null;
}

export interface BenchDeps {
  /** Run the full build pipeline for one case into `dir`; resolve with exit code + combined log. */
  build: (c: BenchCase, dir: string) => Promise<{ exitCode: number; log: string }>;
  /** Deploy a gate-green workspace; resolve with exit code + log (the URL is parsed from it). */
  ship: (dir: string) => Promise<{ exitCode: number; log: string }>;
  /** HTTP-probe the deployed URL; resolve with the status (0 = unreachable). */
  probe: (url: string) => Promise<number>;
  /** Workspace dir for a case id. */
  workspaceFor: (id: string) => string;
  now?: () => number;
  onCase?: (r: BenchResult) => void;
}

const TAIL = 900;

export async function runBenchmark(corpus: BenchCase[], deps: BenchDeps): Promise<BenchReport> {
  const now = deps.now ?? Date.now;
  const results: BenchResult[] = [];
  for (const c of corpus) {
    const started = now();
    const dir = deps.workspaceFor(c.id);
    let r: BenchResult;
    try {
      const b = await deps.build(c, dir);
      const ticket = parseHeldTicket(b.log);
      const attempts = parseAttempts(b.log);
      const blocking = parseFinalBlockingGates(b.log);
      if (b.exitCode !== 0) {
        r = {
          id: c.id,
          outcome: ticket ? "held" : "build-failed",
          blockingGates: blocking,
          attempts,
          ticket,
          wallClockMs: now() - started,
          url: null,
          probeStatus: null,
          logTail: b.log.slice(-TAIL),
        };
      } else {
        const s = await deps.ship(dir);
        const url = parseShipUrl(s.log);
        if (s.exitCode !== 0 || !url) {
          r = { id: c.id, outcome: "ship-failed", blockingGates: [], attempts, ticket: null, wallClockMs: now() - started, url, probeStatus: null, logTail: s.log.slice(-TAIL) };
        } else {
          const status = await deps.probe(url).catch(() => 0);
          r = {
            id: c.id,
            outcome: status >= 200 && status < 300 ? "shipped" : "not-loadable",
            blockingGates: [],
            attempts,
            ticket: null,
            wallClockMs: now() - started,
            url,
            probeStatus: status,
            logTail: s.log.slice(-TAIL),
          };
        }
      }
    } catch (e) {
      r = {
        id: c.id,
        outcome: "build-failed",
        blockingGates: [],
        attempts: null,
        ticket: null,
        wallClockMs: now() - started,
        url: null,
        probeStatus: null,
        logTail: e instanceof Error ? e.message : String(e),
      };
    }
    results.push(r);
    deps.onCase?.(r);
  }
  const shipped = results.filter((x) => x.outcome === "shipped").length;
  return { results, total: corpus.length, shipped, score: corpus.length ? shipped / corpus.length : 0 };
}

/** One-screen report. LEADS with the score — the reporting standard. */
export function formatBenchReport(report: BenchReport): string {
  const lines = [`benchmark: ${report.shipped}/${report.total} shipped (target ≥8/10)`, ""];
  for (const r of report.results) {
    const mark = r.outcome === "shipped" ? "✅" : "🛑";
    const mins = (r.wallClockMs / 60000).toFixed(1);
    const bits: string[] = [r.outcome];
    if (r.url) bits.push(r.url);
    if (r.probeStatus !== null) bits.push(`probe ${r.probeStatus}`);
    if (r.blockingGates.length) bits.push(`blocked by: ${r.blockingGates.join(", ")}`);
    if (r.attempts !== null) bits.push(`${r.attempts} fix attempt(s)`);
    if (r.ticket) bits.push(`ticket ${r.ticket}`);
    bits.push(`${mins}m`);
    lines.push(`  ${mark} ${r.id} — ${bits.join(" · ")}`);
  }
  return lines.join("\n");
}
