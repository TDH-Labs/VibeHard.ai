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

  test("mode and extra args are passed positionally to cli.ts", async () => {
    const sandbox = new FakeSandbox("sbx-4");
    const worker = new E2BBuildWorker({
      createSandbox: fakeCreateSandbox(sandbox),
      workspaceStore: fakeWorkspaceStore(),
      buildLogStore: new InMemoryBuildLogStore(),
      fetchEnv: async () => ({}),
    });

    await worker.dispatch({ ...baseOpts, mode: "build", args: ["a tutoring app for kids"] });

    const cliCall = sandbox.commands.find((c) => c.cmd.includes("bun src/cli.ts"))!;
    expect(cliCall.cmd).toContain("'build'");
    expect(cliCall.cmd).toContain("'a tutoring app for kids'");
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
