/**
 * Fly exec sandbox (EPIC #32, extending #32a). `fly-sandbox.ts`'s `runInFlySandbox` isolates a
 * container app's DEPLOY+BOOT — it needs a servable HTTP app. Some verify paths only need to run
 * a one-shot command (`npm install && npm run build`) and check the exit code — there's nothing to
 * serve or probe. This runs that command inside an ephemeral, resource-capped Fly machine instead
 * of `fly machine run`'s image build happening ON the platform host, and ALWAYS tears the app down.
 *
 * Same seams as fly-sandbox.ts: an injectable CommandRunner (bunRunner in prod, a capturing fake in
 * tests — no real Fly calls in the test suite), an injectable ephemeral-name generator.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "./vercel.ts";
import { bunRunner } from "./vercel.ts";

export interface ExecSandboxResult {
  /** the command exited 0 inside the isolated machine */
  ok: boolean;
  exitCode: number;
  /** combined stdout+stderr tail (never the app's secrets — only what the command printed) */
  log: string;
}

export interface FlyExecSandboxDeps {
  runner?: CommandRunner; // bunRunner in prod; a capturing fake in tests
  name?: () => string; // ephemeral app-name generator (injected so tests are deterministic)
  token?: string; // FLY_API_TOKEN; defaults to process.env.FLY_API_TOKEN
  org?: string; // default "personal"
  memoryMb?: number; // default 512 — resource cap on the ephemeral machine
  flyBin?: string[]; // default ["fly"]
}

/**
 * Write `dockerfile` into `workspacePath` (transiently — removed in `finally`, mirroring
 * FlyHostProvider's fly.toml handling), build+run it as a throwaway Fly machine with `command`
 * overriding the image's own CMD, capture the machine's console output, and ALWAYS destroy the
 * ephemeral app. Never throws — a deploy/exec failure comes back as `ok: false`.
 */
export async function runInFlyExecSandbox(
  workspacePath: string,
  dockerfile: string,
  command: string[],
  deps: FlyExecSandboxDeps = {},
): Promise<ExecSandboxResult> {
  const token = deps.token ?? process.env.FLY_API_TOKEN ?? "";
  if (!token) return { ok: false, exitCode: 1, log: "FlyExecSandbox: missing FLY_API_TOKEN" };
  const runner = deps.runner ?? bunRunner;
  const org = deps.org ?? process.env.FLY_ORG ?? "personal";
  const memoryMb = deps.memoryMb ?? 512;
  const flyBin = deps.flyBin ?? ["fly"];
  const app = (deps.name ?? (() => `vibehard-exec-${Date.now().toString(36)}`))();
  const flyEnv = { FLY_API_TOKEN: token };
  const dockerfilePath = join(workspacePath, "Dockerfile.vibehard-sandbox");

  writeFileSync(dockerfilePath, dockerfile);
  try {
    // best-effort create — harmlessly non-zero if it already exists (idempotent, mirrors FlyHostProvider)
    await runner.run([...flyBin, "apps", "create", app, "--org", org], { cwd: workspacePath, env: flyEnv });
    const res = await runner.run(
      [
        ...flyBin,
        "machine",
        "run",
        ".",
        "--dockerfile",
        dockerfilePath,
        "--app",
        app,
        "--region",
        process.env.FLY_REGION ?? "iad",
        "--rm", // remove the machine the moment the command exits — no idle leftover
        "--vm-memory",
        String(memoryMb),
        ...command,
      ],
      { cwd: workspacePath, env: flyEnv },
    );
    const log = `${res.stdout}${res.stderr}`.trim();
    return { ok: res.exitCode === 0, exitCode: res.exitCode, log: log.slice(-2000) };
  } catch (e) {
    return { ok: false, exitCode: 1, log: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      rmSync(dockerfilePath, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    try {
      await runner.run([...flyBin, "apps", "destroy", app, "--yes"], { cwd: workspacePath, env: flyEnv }); // ALWAYS torn down
    } catch {
      /* best-effort teardown — never mask the exec result */
    }
  }
}
