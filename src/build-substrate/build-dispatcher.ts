/**
 * BuildDispatcher — the ONE place that decides whether a build's actual compute runs as a local
 * subprocess (today's default, unchanged) or on an ephemeral BuildWorker sandbox
 * (docs/build-substrate/{SPEC,PRD,ARCHITECTURE}.md, W4). Both of the platform's existing spawn
 * call sites — web/server.ts's `buildStream()` (runStep's inline `Bun.spawn`) and
 * src/orchestrator-glue/build-tools.ts's `realBuildTools().retry()` (its own inline `spawn`) —
 * go through this ONE `RunPipeline` contract instead of spawning `bun src/cli.ts ...` directly.
 *
 * Provider selection is an explicit env flag (`VIBEHARD_BUILD_WORKER=e2b`), defaulting to local.
 * This workstream REPLACES the call sites (closing W4) without itself flipping runtime behavior
 * for real traffic — that's the separate, deliberately-gated Cutover step, done only after a
 * real end-to-end E2B dispatch has been proven to work end to end.
 */
import type { BuildLogStore } from "./build-log-store.ts";
import { cliPositionalArgs, type BuildWorker, type BuildMode } from "./build-worker.ts";

export interface RunPipelineOptions {
  tenantId: string;
  app: string;
  mode: BuildMode;
  /** Extra positional args after the workspace dir (e.g. a prompt for `build`/`change`). */
  args?: string[];
  /** Local workspace dir — always used for the LOCAL path; for the E2B path this is where the
   *  dispatcher's own caller keeps the same local mirror it maintains today (steering writes
   *  etc.), NOT where the sandbox's own copy lives (that's WorkspaceStore's job, via Tigris). */
  workspace: string;
  env: Record<string, string>;
  onLog?: (line: string) => void;
  /** LOCAL path only: lets the caller wire in its own kill()-based stop mechanism (e.g.
   *  web/server.ts's `running` Map, read by `/api/build/stop`). No-op for the E2B path, which
   *  uses the durable stop-flag instead (W5a) — the caller sets that flag independently via
   *  BuildProgressStore.patchActive, not through this seam. */
  registerKill?: (kill: () => void) => void;
  unregisterKill?: () => void;
}

export interface RunPipelineResult {
  exitCode: number;
  /** True only for the E2B path when a cooperative stop was honored (W5a). Always false for
   *  the local path — its kill()-based stop is visible via a killed/nonzero exitCode instead,
   *  same as today; callers already have their own stopFlags-based interpretation for that. */
  stopped: boolean;
}

export type RunPipeline = (opts: RunPipelineOptions) => Promise<RunPipelineResult>;

const CLI = "src/cli.ts"; // relative to repoRoot — same relative path E2BBuildWorker uses inside the sandbox

/** Today's exact behavior (buildStream()'s runStep / build-tools.ts's retry, unified into one
 *  function): a plain local Bun subprocess, line-buffered stdout/stderr tee. Zero behavior
 *  change from what either call site did inline before this workstream — this is a lift, not a
 *  rewrite. */
export function localSpawnPipeline(repoRoot: string): RunPipeline {
  return async (opts) => {
    const args = [opts.mode, ...cliPositionalArgs(opts.mode, opts.workspace, opts.args ?? [])];
    const proc = Bun.spawn(["bun", CLI, ...args], { cwd: repoRoot, env: opts.env, stdout: "pipe", stderr: "pipe" });
    opts.registerKill?.(() => proc.kill());
    const pump = async (rs: ReadableStream<Uint8Array>) => {
      const reader = rs.getReader();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const ln of lines) if (ln.trim()) opts.onLog?.(ln);
      }
      if (buf.trim()) opts.onLog?.(buf);
    };
    await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    const exitCode = await proc.exited;
    opts.unregisterKill?.();
    return { exitCode, stopped: false };
  };
}

export interface E2BPipelineOptions {
  worker: BuildWorker;
  buildLogStore: BuildLogStore;
  /** Mints the single-use secrets token for this one dispatch (W5b) — the caller owns the
   *  SecretsTokenStore; this seam only needs the resulting opaque token. */
  mintSecretsToken: (env: Record<string, string>) => Promise<string>;
  /** Mints the reusable dispatch/stop-check token for this dispatch (W5a/W6). */
  mintStopCheckToken: (tenantId: string, app: string) => Promise<string>;
  pollIntervalMs?: number;
}

/** Dispatches onto an ephemeral BuildWorker sandbox instead of a local subprocess — same
 *  RunPipeline contract, so callers don't know or care which one ran. "Live" output is polled
 *  from the SAME durable BuildLogStore the sandbox's own output is teed into (W2/W3),
 *  concurrently with the (necessarily blocking) dispatch() call — not a true push, but the exact
 *  mechanism a reconnecting SSE client already relies on (poll-and-tail from a last-seen seq),
 *  so it's a consistent, already-proven shape rather than a new one. */
export function e2bPipeline(opts: E2BPipelineOptions): RunPipeline {
  return async (run) => {
    const scope = `${run.tenantId}:${run.app}`;
    const secretsToken = await opts.mintSecretsToken(run.env);
    const stopCheckToken = await opts.mintStopCheckToken(run.tenantId, run.app);
    let lastSeq = 0;
    let polling = true;
    const drain = async () => {
      const lines = await opts.buildLogStore.since(scope, lastSeq);
      for (const l of lines) {
        lastSeq = l.seq;
        run.onLog?.(l.line);
      }
    };
    const pollLoop = (async () => {
      while (polling) {
        await new Promise((r) => setTimeout(r, opts.pollIntervalMs ?? 1000));
        await drain();
      }
    })();
    try {
      const result = await opts.worker.dispatch({
        tenantId: run.tenantId,
        app: run.app,
        mode: run.mode,
        args: run.args,
        secretsToken,
        stopCheckToken,
      });
      return { exitCode: result.exitCode, stopped: result.stopped };
    } finally {
      polling = false;
      await pollLoop;
      await drain(); // final catch-up: anything appended between the last tick and dispatch resolving
    }
  };
}
