/**
 * Shared cooperative-stop contract between cli.ts's checkpointHook and a BuildWorker
 * (docs/build-substrate/{SPEC,PRD,ARCHITECTURE}.md, W5a / SPEC decision #6). A BuildWorker's
 * checkpoint script, after each successful push, pings the platform's checkpoint-ping endpoint
 * and — if the tenant's durable `ActiveBuild.stopRequested` flag is set — exits with this
 * sentinel code instead of 0. checkpointHook (cli.ts) recognizes it and throws
 * BuildStoppedError instead of the generic "checkpoint command failed" error, so
 * runAutoFixAndReport can tell "the operator asked to stop" apart from "the checkpoint push
 * itself broke" and report each distinctly (SPEC decision #6: cooperative, not SIGKILL — the
 * worker finishes its current round's checkpoint before yielding, never torn down mid-write).
 *
 * A tiny, dedicated module (not folded into cli.ts or build-worker.ts) specifically so neither
 * side needs to import the other's much heavier dependency graph just for one constant + one
 * error class.
 */

/** Deliberately not 0 (success), 1 (held/blocked — runAutoFixAndReport's existing convention),
 *  or 2 (CLI usage errors elsewhere in cli.ts) — and outside sh's own low reserved range. */
export const STOP_EXIT_CODE = 42;

export class BuildStoppedError extends Error {
  constructor(round: number) {
    super(`build stopped cooperatively after round ${round}`);
    this.name = "BuildStoppedError";
  }
}
