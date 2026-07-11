import { describe, expect, test } from "bun:test";
import { E2BBuildWorker, type CreateSandbox, type SandboxHandle, type DispatchOptions } from "./build-worker.ts";
import { InMemoryBuildLogStore } from "./build-log-store.ts";

interface RecordedCommand {
  cmd: string;
  opts?: { timeoutMs?: number; envs?: Record<string, string> };
}

/** A fake sandbox that records everything sent to it and lets a test script custom exit
 *  codes/stdout per command — no real E2B dependency anywhere in this file. */
class FakeSandbox implements SandboxHandle {
  readonly sandboxId: string;
  readonly files = new Map<string, string>();
  readonly commands: RecordedCommand[] = [];
  killed = false;

  constructor(
    id: string,
    private readonly exitCodeFor: (cmd: string) => number = () => 0,
    private readonly stdoutFor: (cmd: string) => string | undefined = () => undefined,
  ) {
    this.sandboxId = id;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async runCommand(
    cmd: string,
    opts?: { timeoutMs?: number; envs?: Record<string, string>; onStdout?: (c: string) => void | Promise<void>; onStderr?: (c: string) => void | Promise<void> },
  ): Promise<{ exitCode: number }> {
    this.commands.push({ cmd, opts: { timeoutMs: opts?.timeoutMs, envs: opts?.envs } });
    const out = this.stdoutFor(cmd);
    if (out && opts?.onStdout) await opts.onStdout(out);
    return { exitCode: this.exitCodeFor(cmd) };
  }

  async kill(): Promise<void> {
    this.killed = true;
  }
}

function fakeCreateSandbox(sandbox: FakeSandbox): CreateSandbox {
  return async () => sandbox;
}

function fakeWorkspaceStore(pullUrl = "https://tigris.example/pull", pushUrl = "https://tigris.example/push") {
  return { presign: async () => ({ pullUrl, pushUrl }) } as unknown as import("./workspace-store.ts").TigrisWorkspaceStore;
}

const baseOpts: DispatchOptions = { tenantId: "t-1", app: "app-1", mode: "fix", secretsToken: "tok-abc" };

describe("E2BBuildWorker.dispatch — happy path", () => {
  test("runs pull, checkpoint chmod, the cli command, and a final checkpoint push, then kills the sandbox", async () => {
    const sandbox = new FakeSandbox("sbx-1", () => 0);
    const logStore = new InMemoryBuildLogStore();
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: logStore,
      fetchEnv: async () => ({ VIBEHARD_TENANT_LLM_KEY: "sk-secret-value" }),
    });

    const result = await worker.dispatch(baseOpts);

    expect(result.exitCode).toBe(0);
    expect(result.finalPushOk).toBe(true);
    expect(result.workerId).toBe("sbx-1");
    expect(sandbox.killed).toBe(true);

    const cmds = sandbox.commands.map((c) => c.cmd);
    expect(cmds.some((c) => c.includes("chmod +x /home/user/checkpoint.sh"))).toBe(true);
    expect(cmds.some((c) => c.includes("curl -sf -o /tmp/pull.tar") && c.includes("|| true"))).toBe(true);
    expect(cmds.some((c) => c.includes("bun src/cli.ts") && c.includes("'fix'") && c.includes("/home/user/workspace"))).toBe(true);
    // final push runs the checkpoint script directly
    expect(cmds.filter((c) => c === "/home/user/checkpoint.sh").length).toBeGreaterThanOrEqual(1);
  });

  test("secrets reach the sandbox via structured envs, never interpolated into the command text", async () => {
    const sandbox = new FakeSandbox("sbx-2");
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({ SECRET_KEY: "sk-should-never-appear-in-cmd-text" }),
    });

    await worker.dispatch(baseOpts);

    const cliCall = sandbox.commands.find((c) => c.cmd.includes("bun src/cli.ts"));
    expect(cliCall).toBeDefined();
    expect(cliCall!.cmd).not.toContain("sk-should-never-appear-in-cmd-text");
    expect(cliCall!.opts?.envs?.SECRET_KEY).toBe("sk-should-never-appear-in-cmd-text");
    expect(cliCall!.opts?.envs?.VIBEHARD_CHECKPOINT_CMD).toBe("/home/user/checkpoint.sh");
  });

  test("presigned pull/push URLs are quoted into the script/commands, never leaked into env or logs", async () => {
    const sandbox = new FakeSandbox("sbx-3");
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore("https://tigris.example/PULL_TOKEN", "https://tigris.example/PUSH_TOKEN"),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
    });

    await worker.dispatch(baseOpts);

    expect(sandbox.files.get("/home/user/checkpoint.sh")).toContain("PUSH_TOKEN");
    const pullCmd = sandbox.commands.find((c) => c.cmd.includes("/tmp/pull.tar"));
    expect(pullCmd!.cmd).toContain("PULL_TOKEN");
  });

  test("THE BUG THIS CLOSES: build's prompt comes BEFORE the workspace dir (cli.ts: `build \"<prompt>\" <dir>`) — workspace-first silently breaks every build", async () => {
    const sandbox = new FakeSandbox("sbx-4");
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
    });

    await worker.dispatch({ ...baseOpts, mode: "build", args: ["a tutoring app for kids"] });

    const cliCall = sandbox.commands.find((c) => c.cmd.includes("bun src/cli.ts"))!;
    // exact positional order, not just containment — a containment-only check would have missed
    // the real bug this closes (workspace and prompt swapped)
    expect(cliCall.cmd).toContain("bun src/cli.ts 'build' 'a tutoring app for kids' '/home/user/workspace'");
  });

  test("change's request text ALSO comes before the workspace dir (cli.ts: `change \"<request>\" <dir>`)", async () => {
    const sandbox = new FakeSandbox("sbx-4b");
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
    });
    await worker.dispatch({ ...baseOpts, mode: "change", args: ["add a dark mode toggle"] });
    const cliCall = sandbox.commands.find((c) => c.cmd.includes("bun src/cli.ts"))!;
    expect(cliCall.cmd).toContain("bun src/cli.ts 'change' 'add a dark mode toggle' '/home/user/workspace'");
  });

  test("fix/ship/polish/rollback take ONLY the workspace dir (cli.ts: `fix <dir>`, no prompt) — dir comes right after the mode", async () => {
    const sandbox = new FakeSandbox("sbx-4c");
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
    });
    await worker.dispatch({ ...baseOpts, mode: "ship" });
    const cliCall = sandbox.commands.find((c) => c.cmd.includes("bun src/cli.ts"))!;
    expect(cliCall.cmd).toContain("bun src/cli.ts 'ship' '/home/user/workspace'");
  });

  test("templateId is threaded through to sandbox creation", async () => {
    const sandbox = new FakeSandbox("sbx-5");
    let capturedTemplateId: string | undefined;
    const createSandbox: CreateSandbox = async (opts) => {
      capturedTemplateId = opts.templateId;
      return sandbox;
    };
    const worker = new E2BBuildWorker({
      createSandbox,
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
      templateId: "vibehard-build-worker-v1",
    });

    await worker.dispatch(baseOpts);
    expect(capturedTemplateId).toBe("vibehard-build-worker-v1");
  });
});

describe("E2BBuildWorker.dispatch — live output streaming into BuildLogStore", () => {
  test("stdout from the cli command is teed into the durable log, line-buffered", async () => {
    const sandbox = new FakeSandbox("sbx-6", () => 0, (cmd) => (cmd.includes("bun src/cli.ts") ? "line one\nline two\nline thr" : undefined));
    const logStore = new InMemoryBuildLogStore();
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: logStore,
      fetchEnv: async () => ({}),
    });

    await worker.dispatch(baseOpts);

    const lines = await logStore.since("t-1:app-1", 0);
    expect(lines.map((l) => l.line)).toEqual(["line one", "line two", "line thr"]); // trailing partial line flushed
  });
});

describe("E2BBuildWorker.dispatch — cooperative stop-check ping (build-substrate W5a/W6)", () => {
  test("no stopCheckToken and/or no platformBaseUrl → the checkpoint script has no ping at all (unchanged default behavior)", async () => {
    const sandbox = new FakeSandbox("sbx-10");
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
      // platformBaseUrl deliberately unset
    });
    await worker.dispatch({ ...baseOpts, stopCheckToken: "ping-tok" });
    expect(sandbox.files.get("/home/user/checkpoint.sh")).not.toContain("build-checkpoint-ping");
  });

  test("both stopCheckToken and platformBaseUrl set → the checkpoint script pings the platform, token never in the command text", async () => {
    const sandbox = new FakeSandbox("sbx-11");
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
      platformBaseUrl: "https://vibehard.example",
    });
    await worker.dispatch({ ...baseOpts, stopCheckToken: "ping-tok-xyz" });
    const script = sandbox.files.get("/home/user/checkpoint.sh")!;
    expect(script).toContain("https://vibehard.example/api/internal/build-checkpoint-ping");
    expect(script).toContain("ping-tok-xyz"); // present in the script body (curl -d payload), which is expected/necessary
    expect(script).toContain('"stopRequested":true');
  });

  test("the cli subprocess exiting via STOP_EXIT_CODE is reported as stopped:true, distinct from a real failure", async () => {
    const sandbox = new FakeSandbox("sbx-12", (cmd) => (cmd.includes("bun src/cli.ts") ? 42 : 0));
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
      platformBaseUrl: "https://vibehard.example",
    });
    const result = await worker.dispatch({ ...baseOpts, stopCheckToken: "ping-tok" });
    expect(result.exitCode).toBe(42);
    expect(result.stopped).toBe(true);
    expect(result.finalPushOk).toBe(true); // the checkpoint itself still succeeded — stopping isn't an infra failure
    expect(sandbox.killed).toBe(true); // still torn down cleanly, same as any other terminal outcome
  });

  test("a normal exit code (0) is reported as stopped:false", async () => {
    const sandbox = new FakeSandbox("sbx-13");
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
    });
    const result = await worker.dispatch(baseOpts);
    expect(result.stopped).toBe(false);
  });
});

describe("E2BBuildWorker.dispatch — checkpoint-push-then-destroy contract (SPEC decision #4)", () => {
  test("a final push that keeps failing means the sandbox is NEVER killed, and finalPushOk is false", async () => {
    const sandbox = new FakeSandbox("sbx-7", (cmd) => (cmd === "/home/user/checkpoint.sh" ? 1 : 0)); // checkpoint always fails
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
    });

    const result = await worker.dispatch(baseOpts);

    expect(result.finalPushOk).toBe(false);
    expect(sandbox.killed).toBe(false); // never destroyed with unsaved state
  });

  test("a final push that fails twice then succeeds still results in the sandbox being killed", async () => {
    let checkpointCalls = 0;
    const sandbox = new FakeSandbox("sbx-8", (cmd) => {
      if (cmd !== "/home/user/checkpoint.sh") return 0;
      checkpointCalls++;
      return checkpointCalls < 3 ? 1 : 0; // fails twice, succeeds on the 3rd (retry) attempt
    });
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
    });

    const result = await worker.dispatch(baseOpts);
    expect(result.finalPushOk).toBe(true);
    expect(sandbox.killed).toBe(true);
    expect(checkpointCalls).toBe(3);
  });

  test("the cli command's own exit code is preserved even when it's non-zero (a real build failure, not an infra failure)", async () => {
    const sandbox = new FakeSandbox("sbx-9", (cmd) => (cmd.includes("bun src/cli.ts") ? 1 : 0));
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
    });

    const result = await worker.dispatch(baseOpts);
    expect(result.exitCode).toBe(1);
    expect(result.finalPushOk).toBe(true); // the checkpoint itself still succeeded — a build failure isn't an infra failure
    expect(sandbox.killed).toBe(true); // still torn down: the failure is recorded durably, nothing left unsaved
  });
});
