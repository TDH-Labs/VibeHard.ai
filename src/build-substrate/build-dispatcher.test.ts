import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localSpawnPipeline, e2bPipeline } from "./build-dispatcher.ts";
import { InMemoryBuildLogStore } from "./build-log-store.ts";
import type { BuildWorker, DispatchOptions, BuildWorkerResult } from "./build-worker.ts";

describe("localSpawnPipeline — a lift of buildStream()'s runStep/build-tools.ts's retry, unified", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A real repoRoot with its own tiny src/cli.ts standing in for the real (heavy) CLI —
   *  proves the real spawn+line-buffered-tee mechanics work end to end without needing
   *  VibeHard's actual pipeline. */
  function fakeRepoRoot(script: string): string {
    const root = mkdtempSync(join(tmpdir(), "vibehard-dispatcher-repo-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "cli.ts"), script);
    return root;
  }

  test("runs `bun src/cli.ts <mode> <workspace> <args>`, tees stdout line-buffered, reports the real exit code", async () => {
    const root = fakeRepoRoot(`
      console.log("line one");
      console.log("line two");
      process.exit(0);
    `);
    const lines: string[] = [];
    const pipeline = localSpawnPipeline(root);
    const result = await pipeline({
      tenantId: "t1",
      app: "app1",
      mode: "fix",
      workspace: "/tmp/whatever",
      env: { ...process.env, FOO: "bar" } as Record<string, string>,
      onLog: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stopped).toBe(false);
    expect(lines).toEqual(["line one", "line two"]);
  });

  test("THE BUG THIS CLOSES: build's prompt comes BEFORE the workspace dir (cli.ts: `build \"<prompt>\" <dir>`)", async () => {
    const root = fakeRepoRoot(`console.log(process.argv.slice(2).join("|"));`);
    const lines: string[] = [];
    const pipeline = localSpawnPipeline(root);
    await pipeline({
      tenantId: "t1",
      app: "app1",
      mode: "build",
      args: ["a tutoring app"],
      workspace: "/tmp/ws",
      env: process.env as Record<string, string>,
      onLog: (l) => lines.push(l),
    });
    expect(lines[0]).toBe("build|a tutoring app|/tmp/ws");
  });

  test("fix (and ship/polish/rollback) take ONLY the workspace dir, right after the mode — no prompt to place first", async () => {
    const root = fakeRepoRoot(`console.log(process.argv.slice(2).join("|"));`);
    const lines: string[] = [];
    const pipeline = localSpawnPipeline(root);
    await pipeline({
      tenantId: "t1",
      app: "app1",
      mode: "fix",
      workspace: "/tmp/ws",
      env: process.env as Record<string, string>,
      onLog: (l) => lines.push(l),
    });
    expect(lines[0]).toBe("fix|/tmp/ws");
  });

  test("a nonzero exit code propagates through untouched", async () => {
    const root = fakeRepoRoot(`process.exit(3);`);
    const pipeline = localSpawnPipeline(root);
    const result = await pipeline({ tenantId: "t1", app: "app1", mode: "fix", workspace: "/tmp/ws", env: process.env as Record<string, string> });
    expect(result.exitCode).toBe(3);
  });

  test("registerKill/unregisterKill are wired so a caller can implement its own stop button", async () => {
    const root = fakeRepoRoot(`await new Promise((r) => setTimeout(r, 60000));`);
    const pipeline = localSpawnPipeline(root);
    let killFn: (() => void) | undefined;
    let unregistered = false;
    const promise = pipeline({
      tenantId: "t1",
      app: "app1",
      mode: "fix",
      workspace: "/tmp/ws",
      env: process.env as Record<string, string>,
      registerKill: (k) => (killFn = k),
      unregisterKill: () => (unregistered = true),
    });
    // give the subprocess a moment to actually start before killing it
    await new Promise((r) => setTimeout(r, 200));
    expect(killFn).toBeDefined();
    killFn!();
    const result = await promise;
    expect(result.exitCode).not.toBe(0); // killed, not a clean exit
    expect(unregistered).toBe(true);
  });
});

describe("e2bPipeline — same RunPipeline contract, dispatched onto a BuildWorker instead", () => {
  function fakeWorker(result: Partial<BuildWorkerResult> = {}): { worker: BuildWorker; calls: DispatchOptions[] } {
    const calls: DispatchOptions[] = [];
    const worker: BuildWorker = {
      async dispatch(opts) {
        calls.push(opts);
        return { workerId: "sbx-1", exitCode: 0, finalPushOk: true, stopped: false, wallMs: 1000, ...result };
      },
    };
    return { worker, calls };
  }

  test("mints both tokens and passes them through to worker.dispatch", async () => {
    const { worker, calls } = fakeWorker();
    const pipeline = e2bPipeline({
      worker,
      buildLogStore: new InMemoryBuildLogStore(),
      mintSecretsToken: async () => "secrets-tok",
      mintStopCheckToken: async () => "stop-tok",
      pollIntervalMs: 10,
    });
    await pipeline({ tenantId: "t1", app: "app1", mode: "fix", workspace: "/irrelevant", env: { A: "B" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.secretsToken).toBe("secrets-tok");
    expect(calls[0]!.stopCheckToken).toBe("stop-tok");
    expect(calls[0]!.tenantId).toBe("t1");
    expect(calls[0]!.app).toBe("app1");
    expect(calls[0]!.mode).toBe("fix");
  });

  test("live output is polled from BuildLogStore and delivered via onLog, in order, no duplicates", async () => {
    const logStore = new InMemoryBuildLogStore();
    const { worker } = fakeWorker();
    const wrappedWorker: BuildWorker = {
      async dispatch(opts) {
        // simulate lines arriving WHILE the dispatch is in flight, like a real sandbox teeing output
        await logStore.append(`${opts.tenantId}:${opts.app}`, "first line");
        await new Promise((r) => setTimeout(r, 30));
        await logStore.append(`${opts.tenantId}:${opts.app}`, "second line");
        await new Promise((r) => setTimeout(r, 30));
        return worker.dispatch(opts);
      },
    };
    const pipeline = e2bPipeline({
      worker: wrappedWorker,
      buildLogStore: logStore,
      mintSecretsToken: async () => "tok",
      mintStopCheckToken: async () => "tok2",
      pollIntervalMs: 10,
    });
    const lines: string[] = [];
    await pipeline({ tenantId: "t1", app: "app1", mode: "fix", workspace: "/x", env: {}, onLog: (l) => lines.push(l) });
    expect(lines).toEqual(["first line", "second line"]);
  });

  test("result.stopped reflects the worker's own stopped flag", async () => {
    const { worker } = fakeWorker({ exitCode: 42, stopped: true });
    const pipeline = e2bPipeline({
      worker,
      buildLogStore: new InMemoryBuildLogStore(),
      mintSecretsToken: async () => "tok",
      mintStopCheckToken: async () => "tok2",
    });
    const result = await pipeline({ tenantId: "t1", app: "app1", mode: "fix", workspace: "/x", env: {} });
    expect(result.exitCode).toBe(42);
    expect(result.stopped).toBe(true);
  });
});
