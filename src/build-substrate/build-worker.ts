/**
 * BuildWorker — dispatch one build onto ephemeral, isolated compute (docs/build-substrate/
 * {SPEC,PRD,ARCHITECTURE}.md, W3). Pulls the tenant workspace (W1) into the sandbox via
 * presigned URLs, runs the UNMODIFIED `bun src/cli.ts <mode> <dir>` pipeline exactly as it
 * runs on-host today, tees output to the durable log (W2), checkpoints per autofix iteration
 * via `VIBEHARD_CHECKPOINT_CMD` (see src/cli.ts's `checkpointHook`), and enforces the
 * checkpoint-push-then-destroy contract: the sandbox is torn down ONLY after a successful
 * final push — a push that can't complete holds the sandbox alive rather than destroying it
 * with unsaved state (SPEC decision #4).
 *
 * Nested sandbox creation (the platform's own `verify` gate sandboxing the *generated app's*
 * boot/build check, called from INSIDE this worker) is live-confirmed 2026-07-10 — a real E2B
 * sandbox, given E2B_API_KEY in its own env, created a second sandbox and ran a real command in
 * it. `fetchEnv` below is exactly how that key (and every other tenant secret) reaches here.
 */
import type { BuildLogStore } from "./build-log-store.ts";
import type { TigrisWorkspaceStore } from "./workspace-store.ts";

export type BuildMode = "build" | "fix" | "ship" | "polish" | "change" | "rollback";

export interface DispatchOptions {
  tenantId: string;
  app: string;
  mode: BuildMode;
  /** Extra positional args appended after the workspace dir (e.g. a prompt for `build`). */
  args?: string[];
  /** Opaque token this worker uses to fetch its env via `fetchEnv` — minted by the dispatcher
   *  at dispatch time (build-substrate W5b; the callback endpoint itself is a separate,
   *  not-yet-built workstream — this seam is what it will sit behind). */
  secretsToken: string;
}

export interface BuildWorkerResult {
  workerId: string;
  exitCode: number;
  /** False only if the FINAL checkpoint push could not complete after retries — the sandbox
   *  was deliberately left alive (never destroyed with unsaved state) rather than torn down.
   *  Always true once teardown actually happens. */
  finalPushOk: boolean;
}

export interface BuildWorker {
  dispatch(opts: DispatchOptions): Promise<BuildWorkerResult>;
}

/** Minimal shape of a running sandbox this module needs — deliberately NOT the full E2B SDK
 *  surface, so tests inject a fake without any real E2B dependency at all (same seam
 *  discipline as HostProvider/SecretsStore in src/substrate/types.ts). */
export interface SandboxHandle {
  readonly sandboxId: string;
  writeFile(path: string, content: string): Promise<void>;
  runCommand(
    cmd: string,
    opts?: {
      timeoutMs?: number;
      envs?: Record<string, string>;
      onStdout?: (chunk: string) => void | Promise<void>;
      onStderr?: (chunk: string) => void | Promise<void>;
    },
  ): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

export type CreateSandbox = (opts: { templateId?: string; timeoutMs?: number }) => Promise<SandboxHandle>;

/** Fetch the tenant's build env (BYO LLM key, integration keys, steering rules — the same
 *  values `web/server.ts`'s `buildStream()` assembles in-process today) via the scoped
 *  dispatch token. */
export type FetchEnv = (secretsToken: string) => Promise<Record<string, string>>;

const WORKSPACE_DIR = "/home/user/workspace";
const CHECKPOINT_SCRIPT = "/home/user/checkpoint.sh";
const CLI_PATH = "src/cli.ts"; // relative to the template image's own baked-in VibeHard checkout
const DEFAULT_TIMEOUT_MS = 60 * 60_000; // 1h — real builds run 45+ min (docs/ROADMAP.md observed)
const FINAL_PUSH_ATTEMPTS = 3;

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Buffers partial chunks into complete lines before appending to the durable log — matching
 *  web/server.ts's existing `pump()` line-buffering discipline for the SAME reason: E2B's
 *  onStdout/onStderr deliver arbitrary chunks, not necessarily line-aligned. `flush()` must be
 *  called after the command resolves so a final unterminated line isn't silently dropped. */
function lineTee(scope: string, store: BuildLogStore): { onChunk: (chunk: string) => void; flush: () => Promise<void> } {
  let buf = "";
  return {
    onChunk(chunk: string) {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) void store.append(scope, line);
    },
    async flush() {
      if (buf.trim()) await store.append(scope, buf);
      buf = "";
    },
  };
}

export interface E2BBuildWorkerOptions {
  createSandbox: CreateSandbox;
  workspaceStore: TigrisWorkspaceStore; // needs .presign() — narrower than the generic WorkspaceStore contract
  buildLogStore: BuildLogStore;
  fetchEnv: FetchEnv;
  /** The pre-built custom template ID (ARCHITECTURE.md W3 decision #2: the platform's own
   *  Dockerfile, built once as an E2B template, NOT E2B's stock "base" template). Undefined
   *  falls back to "base" — which has neither VibeHard's source nor its toolchain baked in and
   *  so cannot actually run `cli.ts`. Building + registering the real template needs `e2b auth
   *  login` (interactive browser OAuth) — a genuine credential gap flagged, not worked around;
   *  see this workstream's commit message for the concrete follow-up. */
  templateId?: string;
  timeoutMs?: number;
}

export class E2BBuildWorker implements BuildWorker {
  constructor(private readonly opts: E2BBuildWorkerOptions) {}

  async dispatch(d: DispatchOptions): Promise<BuildWorkerResult> {
    const scope = `${d.tenantId}:${d.app}`;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sandbox = await this.opts.createSandbox({ templateId: this.opts.templateId, timeoutMs });

    let finalPushOk = false;
    try {
      const { pullUrl, pushUrl } = await this.opts.workspaceStore.presign(d.tenantId, d.app);
      const env = await this.opts.fetchEnv(d.secretsToken);

      await sandbox.writeFile(
        CHECKPOINT_SCRIPT,
        [
          "#!/bin/sh",
          "set -e",
          `tar -cf /tmp/checkpoint.tar -C ${WORKSPACE_DIR} .`,
          `curl -sf -T /tmp/checkpoint.tar ${shQuote(pushUrl)}`,
          "rm -f /tmp/checkpoint.tar",
        ].join("\n"),
      );
      await sandbox.runCommand(`chmod +x ${CHECKPOINT_SCRIPT}`);

      // Pull the prior workspace — tolerant of a missing object (a presigned GET on a
      // non-existent key 404s; `|| true` lets a first-ever build proceed with an empty dir,
      // matching WorkspaceStore.pull's own contract, PRD AC1.3).
      const pull = await sandbox.runCommand(
        `mkdir -p ${WORKSPACE_DIR} && (curl -sf -o /tmp/pull.tar ${shQuote(pullUrl)} && tar -xf /tmp/pull.tar -C ${WORKSPACE_DIR} && rm -f /tmp/pull.tar || true)`,
        { timeoutMs },
      );
      if (pull.exitCode !== 0) {
        throw new Error(`workspace pull failed inside sandbox (exit ${pull.exitCode})`);
      }

      const tee = lineTee(scope, this.opts.buildLogStore);
      const cliArgs = [d.mode, WORKSPACE_DIR, ...(d.args ?? [])].map(shQuote).join(" ");
      const run = await sandbox.runCommand(`bun ${CLI_PATH} ${cliArgs}`, {
        timeoutMs,
        envs: { ...env, VIBEHARD_CHECKPOINT_CMD: CHECKPOINT_SCRIPT },
        onStdout: tee.onChunk,
        onStderr: tee.onChunk,
      });
      await tee.flush();

      finalPushOk = await this.finalPush(sandbox);
      return { workerId: sandbox.sandboxId, exitCode: run.exitCode, finalPushOk };
    } finally {
      if (finalPushOk) {
        await sandbox.kill();
      }
      // else: DELIBERATELY leave the sandbox alive — never destroyed with workspace state
      // that was never durably saved. A future retry, the heartbeat/orphan sweep (W6), or
      // E2B's own timeoutMs auto-expiry decides its eventual fate — not this method.
    }
  }

  /** Checkpoint-push-then-destroy, strictly ordered, fails closed (SPEC decision #4) — retried
   *  with backoff, never best-effort (unlike the sandbox's own teardown, which IS best-effort
   *  by design for a genuinely throwaway resource; a checkpoint push is the opposite: the one
   *  thing standing between "this build's progress is durable" and "it dies with the sandbox"). */
  private async finalPush(sandbox: SandboxHandle): Promise<boolean> {
    for (let attempt = 0; attempt < FINAL_PUSH_ATTEMPTS; attempt++) {
      const res = await sandbox.runCommand(CHECKPOINT_SCRIPT);
      if (res.exitCode === 0) return true;
      if (attempt < FINAL_PUSH_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    return false;
  }
}

/** Adapts the real E2B SDK's `Sandbox` to the minimal `SandboxHandle` seam above. Kept as a
 *  standalone factory (not baked into `E2BBuildWorker`) so the class itself never imports the
 *  `e2b` package directly — tests construct `E2BBuildWorker` with a fake `CreateSandbox`
 *  and never touch this function or the real SDK at all. */
export function realE2BSandboxFactory(apiKey: string): CreateSandbox {
  return async ({ templateId, timeoutMs }) => {
    const { Sandbox } = await import("e2b");
    const sandbox = await Sandbox.create({ apiKey, template: templateId, timeoutMs });
    return {
      sandboxId: sandbox.sandboxId,
      writeFile: (path, content) => sandbox.files.write(path, content).then(() => undefined),
      runCommand: (cmd, opts) => sandbox.commands.run(cmd, opts),
      kill: () => sandbox.kill().then(() => undefined),
    };
  };
}
