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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildLogStore } from "./build-log-store.ts";
import type { TigrisWorkspaceStore } from "./workspace-store.ts";
import { STOP_EXIT_CODE } from "./stop-signal.ts";

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
  /** Opaque, reusable token (build-substrate W5a/W6) the checkpoint script pings once per
   *  autofix round to refresh the durable heartbeat and learn whether a stop was requested —
   *  minted by the dispatcher via DispatchTokenStore. Optional: when unset (e.g. every existing
   *  test in this file), the checkpoint script skips the ping entirely — same checkpoint.sh as
   *  before this workstream, zero behavior change for a caller that doesn't opt in. */
  stopCheckToken?: string;
}

export interface BuildWorkerResult {
  workerId: string;
  exitCode: number;
  /** False only if the FINAL checkpoint push could not complete after retries — the sandbox
   *  was deliberately left alive (never destroyed with unsaved state) rather than torn down.
   *  Always true once teardown actually happens. */
  finalPushOk: boolean;
  /** True iff the cli subprocess exited via the cooperative-stop sentinel (build-substrate
   *  W5a) — a stop was requested and honored, NOT a build failure. `exitCode` will equal
   *  STOP_EXIT_CODE in this case; callers should treat that combination as "paused", not
   *  "blocked"/"error". */
  stopped: boolean;
  /** Wall-clock milliseconds the sandbox was alive for, start to teardown (build-substrate W6,
   *  "minimal cost tracking" — SPEC decision #10). Deliberately just a duration, not a dollar
   *  figure: E2B bills by sandbox-seconds × its CPU/memory tier, so this is an honest, cheap
   *  proxy without calling any billing API. Real cost governance/alerting is EPIC #37, out of
   *  scope here — the dispatcher (W4) is responsible for persisting this wherever build history
   *  is tracked; BuildWorker itself has no BuildProgressStore dependency. */
  wallMs: number;
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
const PUSH_SCRIPT = "/home/user/push.sh";
const CLI_PATH = "src/cli.ts"; // relative to the template image's own baked-in VibeHard checkout
// 90m. THE BUG THIS CLOSES (found live 2026-07-22): the old 1h budget only had margin for
// autoFix's OWN 45-min internal ceiling (docs/ROADMAP.md's "real builds run 45+ min" observation),
// not the front-half (spec/PRD/SRS/architecture/codegen) that runs BEFORE autoFix is ever called.
// A real build's front-half + a full 45-min autoFix run (main loop + the 5-attempt no-human
// extension, which shares the SAME internal ceiling but can still overrun it by one in-flight
// round) totaled ~57+ minutes — close enough to the old 1h cap that E2B's OWN external kill won
// the race against autoFix's graceful internal escalation, which never got to run: the sandbox
// was torn down mid-round with NO escalation ticket ever written — a silent "error", not the
// helpful "held, here's why" the same failure produces when autoFix gets to finish on its own.
const DEFAULT_TIMEOUT_MS = 90 * 60_000;
const FINAL_PUSH_ATTEMPTS = 3;
// REAL BUG found live 2026-07-11 (first real end-to-end dispatch, not just a fake-sandbox unit
// test): @vibehard/gate-check's host-lock.ts hardcodes DEFAULT_LOCK_DIR = "/root/.vibehard/
// .host-lock" — fine on the platform's own Fly deployment (runs as root), but the sandbox here
// runs as the non-root `user` E2B provisions by default, so every gate that takes the host lock
// (sast/secrets/depvuln) crashed with EACCES trying to mkdir under /root. host-lock.ts already
// has an escape hatch for exactly this (VIBEHARD_HOST_LOCK_DIR) — no need to touch the shared
// package; just point it at a writable path inside the sandbox.
const HOST_LOCK_DIR = "/home/user/.vibehard/.host-lock";

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** cli.ts's own positional-arg order is NOT uniform across modes — confirmed by reading its
 *  argv destructuring directly, not inferred: `build`/`change` take `<prompt> <dir>` (prompt
 *  FIRST — `usage: vibehard build "<prompt>" <dir>` / `"<request>" <dir>`), while
 *  `fix`/`ship`/`polish`/`rollback` take only `<dir>`. Getting this backwards silently breaks
 *  every build/change dispatch: cli.ts would try to resolve the workspace path as the prompt
 *  and the prompt text as a directory. Shared by both BuildWorker implementations and
 *  build-dispatcher.ts's localSpawnPipeline so this ordering lives in exactly one place. */
export function cliPositionalArgs(mode: BuildMode, workspaceDir: string, args: string[]): string[] {
  if (mode === "build" || mode === "change") return [...args, workspaceDir];
  return [workspaceDir, ...args];
}

/** Pure: the tenant-scoped deploy identity for an app, passed into the sandbox as
 *  VIBEHARD_APP_NAME (cli.ts ship → deployApp → the host provider's app/project name).
 *  THE BUG THIS CLOSES (found live 2026-07-19, acceptance A2's ship): inside a sandbox the
 *  workspace path is always /home/user/workspace, and every name-derivation downstream used
 *  the directory BASENAME — so every sandboxed ship tried to deploy a Fly app literally named
 *  "workspace" (owned by another Fly user) and died "unauthorized". The name must come from
 *  the dispatch identity (app + tenant), never the filesystem. Host-safe: lowercase
 *  alphanumerics + dashes, ≤28 chars (Fly's own limit is ~30; the provider slices further). */
export function deployAppName(app: string, tenantId: string): string {
  const base = app.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "") || "app";
  const scope = tenantId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "t";
  return `${base}-${scope}`;
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

const CHECKPOINT_PING_PATH = "/api/internal/build-checkpoint-ping";

/** The worker image's version stamp — /app/.build-sha, written by scripts/release.sh at release
 *  time and baked into BOTH images by their `COPY . .` (the platform Dockerfile and
 *  e2b.Dockerfile alike). */
const WORKER_SHA_PATH = "/app/.build-sha";

/** Pure: may a dispatch proceed against a worker reporting `workerSha`? null → proceed; else a
 *  human-actionable refusal.
 *
 *  THE BUG THIS CLOSES (found live 2026-07-18 — acceptance test scored 0/3): the E2B template
 *  is a full snapshot of the platform, published OUT-OF-BAND from e2b.Dockerfile. It was built
 *  once (2026-07-11) and never rebuilt through eleven subsequent platform fixes — so every
 *  build a real user dispatched ran week-old code (Supabase forced onto client-only apps, no
 *  golden templates, no lockfile, pre-fix gates), and NOTHING compared the worker's version to
 *  the dispatcher's. Staleness must be impossible to miss silently: the platform refuses to
 *  hand a build to a worker that can't prove it runs the same commit.
 *
 *  No platform stamp → check disabled (dev machines and tests don't stamp — the release script
 *  does). A stamped platform + an UNstamped worker is a refusal, not a skip: every pre-handshake
 *  template is by definition stale. */
export function workerVersionMismatch(platformSha: string | undefined, workerSha: string): string | null {
  const platform = platformSha?.trim();
  if (!platform) return null;
  const worker = workerSha.trim();
  if (!worker) {
    return "the E2B worker template has no version stamp — it predates the version handshake and is guaranteed stale. Republish it from the current commit (scripts/release.sh, or: git rev-parse HEAD > .build-sha && npx @e2b/cli template build).";
  }
  if (worker !== platform) {
    return `the E2B worker template is STALE — built from ${worker.slice(0, 12)}, but the platform is running ${platform.slice(0, 12)}; builds dispatched to it would run old code. Republish it from the current commit (scripts/release.sh).`;
  }
  return null;
}

/** This process's own baked stamp (cwd/.build-sha — /app in the deployed image). Absent →
 *  undefined (handshake disabled; dev machines don't stamp). VIBEHARD_BUILD_SHA overrides for
 *  ops/tests. */
export function readPlatformBuildSha(): string | undefined {
  const env = process.env.VIBEHARD_BUILD_SHA?.trim();
  if (env) return env;
  try {
    return readFileSync(join(process.cwd(), ".build-sha"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface E2BBuildWorkerOptions {
  createSandbox: CreateSandbox;
  workspaceStore: TigrisWorkspaceStore; // needs .presign() — narrower than the generic WorkspaceStore contract
  buildLogStore: BuildLogStore;
  fetchEnv: FetchEnv;
  /** Public base URL the sandbox calls back to for the checkpoint ping (build-substrate
   *  W5a/W6) — the sandbox is a separate machine, not localhost, so this must be the
   *  platform's real public URL (e.g. `https://vibehard.ai`), matching `BASE_URL` in
   *  web/server.ts. Optional: when unset, or when a dispatch has no `stopCheckToken`, the
   *  checkpoint script skips the ping entirely (same behavior as before this workstream). */
  platformBaseUrl?: string;
  /** The pre-built custom template ID (ARCHITECTURE.md W3 decision #2: the platform's own
   *  image, built once as an E2B template, NOT E2B's stock "base" template — "base" has neither
   *  VibeHard's source nor its toolchain baked in and so cannot actually run `cli.ts`). Built
   *  and live-confirmed 2026-07-11 from `e2b.Dockerfile` (repo root — a single-stage twin of
   *  the platform's own Dockerfile; see that file's header for the two E2B-specific
   *  incompatibilities it works around) as template name `vibehard-build-worker`
   *  (id `c9iv75vaji3nmn6opx4g`) — pass that name/id here in the real dispatcher (W4). Live
   *  smoke test confirmed the sandbox's default cwd/user (`/app`, `user`) and every tool this
   *  module depends on resolve with zero extra wiring (docs/build-substrate/PRD.md spike item 5). */
  templateId?: string;
  timeoutMs?: number;
  /** The platform's own commit stamp (readPlatformBuildSha()). When set, every dispatch first
   *  demands the sandbox prove it was built from the SAME commit (workerVersionMismatch) —
   *  refusing stale workers loudly instead of silently running old code. Unset → handshake
   *  disabled (dev/tests). */
  platformSha?: string;
}

export class E2BBuildWorker implements BuildWorker {
  constructor(private readonly opts: E2BBuildWorkerOptions) {}

  async dispatch(d: DispatchOptions): Promise<BuildWorkerResult> {
    const scope = `${d.tenantId}:${d.app}`;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const sandbox = await this.opts.createSandbox({ templateId: this.opts.templateId, timeoutMs });

    // Version handshake BEFORE any workspace work (see workerVersionMismatch): a stale worker
    // is refused outright. Killing here is safe — the sandbox holds no workspace state yet, so
    // the checkpoint-push-then-destroy contract doesn't apply.
    if (this.opts.platformSha) {
      let workerSha = "";
      try {
        await sandbox.runCommand(`cat ${WORKER_SHA_PATH} 2>/dev/null || true`, {
          onStdout: (c) => {
            workerSha += c;
          },
        });
      } catch {
        /* unreadable → treated as unstamped below */
      }
      const mismatch = workerVersionMismatch(this.opts.platformSha, workerSha);
      if (mismatch) {
        await sandbox.kill().catch(() => {});
        throw new Error(`refusing to dispatch build: ${mismatch}`);
      }
    }

    let finalPushOk = false;
    try {
      const { pullUrl, pushUrl } = await this.opts.workspaceStore.presign(d.tenantId, d.app);
      const env = await this.opts.fetchEnv(d.secretsToken);

      const canPing = Boolean(d.stopCheckToken && this.opts.platformBaseUrl);
      const pingUrl = canPing ? `${this.opts.platformBaseUrl}${CHECKPOINT_PING_PATH}` : undefined;
      // PUSH_SCRIPT is JUST tar+push — the one thing both a per-round checkpoint and the FINAL
      // push (below) need. Kept separate from the stop-check ping (THE BUG found live
      // 2026-07-11): finalPush() used to run the SAME script the per-round checkpoint uses,
      // which also pings for a stop — and a real dispatch caught exactly this: the push itself
      // succeeded, but the ping came back stopRequested:true (the dispatcher never having marked
      // any build "active" for this test), so the script exited via STOP_EXIT_CODE (nonzero) —
      // and finalPush(), seeing a nonzero exit, read that as "the push failed" and retried 3x,
      // eventually leaving the sandbox alive despite the workspace having already been durably
      // saved on the very first attempt. Asking "should I stop?" makes no sense for the FINAL
      // push anyway — the build is already over, about to tear down either way.
      await sandbox.writeFile(
        PUSH_SCRIPT,
        ["#!/bin/sh", "set -e", `tar -cf /tmp/checkpoint.tar -C ${WORKSPACE_DIR} .`, `curl -sf -T /tmp/checkpoint.tar ${shQuote(pushUrl)}`, "rm -f /tmp/checkpoint.tar"].join(
          "\n",
        ),
      );
      await sandbox.runCommand(`chmod +x ${PUSH_SCRIPT}`);
      await sandbox.writeFile(
        CHECKPOINT_SCRIPT,
        [
          "#!/bin/sh",
          "set -e",
          PUSH_SCRIPT,
          // build-substrate W5a/W6: refresh the heartbeat + learn whether a stop was requested,
          // once per PER-ROUND checkpoint only (never the final push, above). A ping failure
          // (network blip) is tolerated — it just means this one round's heartbeat/stop-check is
          // skipped, not that the checkpoint itself failed; the push already succeeded by now.
          ...(canPing
            ? [
                `RESP=$(curl -sf -X POST -H 'content-type: application/json' -d ${shQuote(JSON.stringify({ token: d.stopCheckToken }))} ${shQuote(pingUrl!)} || echo '{}')`,
                `case "$RESP" in *'"stopRequested":true'*) exit ${STOP_EXIT_CODE} ;; esac`,
              ]
            : []),
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
      const cliArgs = [d.mode, ...cliPositionalArgs(d.mode, WORKSPACE_DIR, d.args ?? [])].map(shQuote).join(" ");
      // VIBEHARD_PLATFORM_BASE_URL/VIBEHARD_RECORD_TOKEN (found live 2026-07-19, acceptance test
      // prompt C): `cli.ts ship` uses these to reach httpRecordStore — the SAME reusable
      // dispatch token as the checkpoint ping (`canPing` above), reused for a second purpose
      // (see DispatchTokenStore's own doc: resolving it only ever reveals which (tenantId, app)
      // it belongs to). Without a durable record store, `ship` can't tell a redeploy from a
      // first deploy and re-provisions a whole new backend every time — see record-client.ts.
      const recordEnv: Record<string, string> = canPing ? { VIBEHARD_PLATFORM_BASE_URL: this.opts.platformBaseUrl!, VIBEHARD_RECORD_TOKEN: d.stopCheckToken! } : {};
      const run = await sandbox.runCommand(`bun ${CLI_PATH} ${cliArgs}`, {
        timeoutMs,
        // VIBEHARD_APP_NAME: the sanitized, tenant-scoped FLY HOST NAME seed (deployAppName) —
        // inside the sandbox nothing else knows it, and basename-derived names collide globally.
        // VIBEHARD_DISPATCH_APP: the RAW dispatch-level app id (d.app, e.g. "accept-c3") — this,
        // NOT VIBEHARD_APP_NAME, must be the record-store key: it's what the dispatch token
        // (VIBEHARD_RECORD_TOKEN below) was minted against, and httpRecordStore's PUT is
        // authorized by matching the two. THE BUG THIS CLOSES (found live 2026-07-19, right
        // after the reuse fix landed): ship's OWN `app` param was doing double duty as both the
        // host-name seed AND the record key — passing the sanitized/tenant-scoped name for both
        // made every record-store PUT 404 (it no longer matched what the token was scoped to).
        envs: {
          ...env,
          VIBEHARD_CHECKPOINT_CMD: CHECKPOINT_SCRIPT,
          VIBEHARD_HOST_LOCK_DIR: HOST_LOCK_DIR,
          VIBEHARD_APP_NAME: deployAppName(d.app, d.tenantId),
          VIBEHARD_DISPATCH_APP: d.app,
          ...recordEnv,
        },
        onStdout: tee.onChunk,
        onStderr: tee.onChunk,
      });
      await tee.flush();

      finalPushOk = await this.finalPush(sandbox);
      return {
        workerId: sandbox.sandboxId,
        exitCode: run.exitCode,
        finalPushOk,
        stopped: run.exitCode === STOP_EXIT_CODE,
        wallMs: Date.now() - startedAt,
      };
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
      const res = await sandbox.runCommand(PUSH_SCRIPT); // push only — never the stop-check ping, see above
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
    const { Sandbox, CommandExitError } = await import("e2b");
    const sandbox = await Sandbox.create({ apiKey, template: templateId, timeoutMs });
    return {
      sandboxId: sandbox.sandboxId,
      writeFile: (path, content) => sandbox.files.write(path, content).then(() => undefined),
      // REAL BUG found live 2026-07-11 (a real production dispatch, not a unit test): the E2B SDK
      // docs this explicitly ("If the command exits with a non-zero exit code, it throws a
      // CommandExitError") — but SandboxHandle.runCommand's own contract (and every test in
      // build-worker.test.ts's "checkpoint-push-then-destroy" describe block, e.g. "a real build
      // failure (nonzero cli exit) is distinct from an infra failure and still tears down
      // cleanly") assumes it ALWAYS resolves to `{exitCode}`, never throws for a mere nonzero
      // exit. Without this catch, EVERY gate-blocked build (a completely normal, common outcome
      // — not rare) would have thrown out of dispatch() before finalPush() ever ran, orphaning
      // the sandbox (never checkpointed, never torn down) instead of hitting the
      // checkpoint-push-then-destroy path SPEC decision #4 exists for. CommandExitError carries
      // the real CommandResult (exitCode/stdout/stderr) on the error itself — unwrap it back into
      // a normal resolved result; anything else (a genuine infra/network failure, not "the
      // command ran and returned nonzero") still propagates as a thrown error, unchanged.
      runCommand: async (cmd, opts) => {
        try {
          return await sandbox.commands.run(cmd, opts);
        } catch (e) {
          if (e instanceof CommandExitError) return { exitCode: e.exitCode };
          throw e;
        }
      },
      kill: () => sandbox.kill().then(() => undefined),
    };
  };
}
