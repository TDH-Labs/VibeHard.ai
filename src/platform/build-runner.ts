/**
 * LocalBuildRunner — the BuildRunner seam wired to the REAL engine. Where the control plane
 * (Platform.submitBuild/runBuild) owns the job lifecycle + quota, this is what a job actually
 * DOES: run the real gate → fix → re-gate loop (autoFix) on the job's workspace, and if it can't
 * be made to pass, route the localized escalation to the EscalationSink (the human moat — a
 * GitHub issue or the local queue). This connects the four pieces built this session into one
 * flow: control plane → autoFix engine → escalation. The cloud sandbox later swaps in behind
 * this same BuildRunner contract (an isolated container instead of the local process).
 */
import { autoFix as realAutoFix, type AutoFixOptions } from "../autofix/index.ts";
import type { EscalationSink } from "../escalation/index.ts";
import type { BuildJob, BuildRunner } from "./build.ts";

export interface LocalBuildRunnerOptions {
  autoFix?: typeof realAutoFix; // inject for tests; default = the real loop
  sink?: EscalationSink; // where a HELD build escalates (the moat); optional
  autoFixOptions?: AutoFixOptions; // budget / humanAvailable / fixer overrides
  onStep?: (m: string) => void;
}

export class LocalBuildRunner implements BuildRunner {
  private readonly autoFix: typeof realAutoFix;
  private readonly sink?: EscalationSink;
  private readonly autoFixOptions: AutoFixOptions;
  private readonly onStep?: (m: string) => void;

  constructor(opts: LocalBuildRunnerOptions = {}) {
    this.autoFix = opts.autoFix ?? realAutoFix;
    this.sink = opts.sink;
    this.autoFixOptions = opts.autoFixOptions ?? {};
    this.onStep = opts.onStep;
  }

  async run(job: BuildJob): Promise<{ ok: boolean; error?: string }> {
    if (!job.workspacePath) return { ok: false, error: "build job has no workspacePath to build" };
    const result = await this.autoFix(job.workspacePath, { ...this.autoFixOptions, onStep: this.onStep });
    if (result.fixed) return { ok: true }; // gate green (possibly after fixes)
    // Held: hand the localized escalation to the sink (GitHub issue / local queue), if wired.
    if (result.escalation && this.sink) {
      const ticket = await this.sink.open(result.escalation);
      return { ok: false, error: `gate blocked after ${result.attempts} attempt(s); escalated → ${ticket.id}` };
    }
    return { ok: false, error: `gate blocked after ${result.attempts} attempt(s)` };
  }
}
