/**
 * Small, shared CLI-exit-code contracts between cli.ts and its callers (web/server.ts,
 * build-worker.ts) — a tiny, dedicated module (not folded into cli.ts or build-worker.ts)
 * specifically so neither side needs to import the other's much heavier dependency graph just
 * for a handful of constants + one error class.
 *
 * STOP_EXIT_CODE — the cooperative-stop contract between cli.ts's checkpointHook and a
 * BuildWorker (docs/build-substrate/{SPEC,PRD,ARCHITECTURE}.md, W5a / SPEC decision #6). A
 * BuildWorker's checkpoint script, after each successful push, pings the platform's
 * checkpoint-ping endpoint and — if the tenant's durable `ActiveBuild.stopRequested` flag is
 * set — exits with this sentinel code instead of 0. checkpointHook (cli.ts) recognizes it and
 * throws BuildStoppedError instead of the generic "checkpoint command failed" error, so
 * runAutoFixAndReport can tell "the operator asked to stop" apart from "the checkpoint push
 * itself broke" and report each distinctly (SPEC decision #6: cooperative, not SIGKILL — the
 * worker finishes its current round's checkpoint before yielding, never torn down mid-write).
 */

/** Deliberately not 0 (success), 1 (held/blocked — runAutoFixAndReport's existing convention),
 *  or 2 (CLI usage errors elsewhere in cli.ts) — and outside sh's own low reserved range. */
export const STOP_EXIT_CODE = 42;

/** `vibehard ship`'s pre-deploy gate re-check blocked (found live 2026-07-23): both this AND a
 *  genuine post-gate deploy-infrastructure failure (Supabase provisioning, Fly/Vercel deploy)
 *  used to return the SAME exit code 1, so web/server.ts's buildStream() could never tell them
 *  apart — every ship-time gate block was reported to the operator as "Gates passed, but the
 *  deploy itself failed" (factually wrong: the gates did NOT pass) and, unlike every other
 *  held build, got no escalation ticket at all (`runAutoFixAndReport`'s ticket-writing was never
 *  wired into `ship`'s own gate re-check). This sentinel lets web/server.ts route it to the
 *  SAME "blocked" + ticket + orchestrator-notify path a normal auto-fix escalation already gets,
 *  leaving exit code 1 for what it always meant: a genuine post-gate deploy failure. */
export const GATE_BLOCK_EXIT_CODE = 43;

export class BuildStoppedError extends Error {
  constructor(round: number) {
    super(`build stopped cooperatively after round ${round}`);
    this.name = "BuildStoppedError";
  }
}
