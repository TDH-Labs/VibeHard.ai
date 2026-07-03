import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInFlyExecSandbox, type FlyExecSandboxDeps } from "./fly-exec-sandbox.ts";
import type { CommandResult, CommandRunner } from "./vercel.ts";

function capturingRunner(result: Partial<CommandResult> = {}) {
  const calls: Array<{ cmd: string[]; cwd: string; env?: Record<string, string> }> = [];
  const runner: CommandRunner = {
    run: async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd, env: opts.env });
      return { exitCode: 0, stdout: "", stderr: "", ...result };
    },
  };
  return { runner, calls };
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "dd-fly-exec-"));
}

const baseDeps = (runner: CommandRunner): FlyExecSandboxDeps => ({
  runner,
  token: "fly-secret",
  name: () => "vibehard-exec-test",
});

describe("runInFlyExecSandbox — isolate one-shot command exec, always tear down", () => {
  test("a successful command → ok:true, exitCode 0, app created then destroyed", async () => {
    const dir = workspace();
    try {
      const { runner, calls } = capturingRunner({ exitCode: 0, stdout: "build ok\n" });
      const r = await runInFlyExecSandbox(dir, "FROM node:20-alpine\n", ["sh", "-c", "npm run build"], baseDeps(runner));
      expect(r.ok).toBe(true);
      expect(r.exitCode).toBe(0);
      expect(r.log).toContain("build ok");
      expect(calls[0]!.cmd).toEqual(["fly", "apps", "create", "vibehard-exec-test", "--org", "personal"]);
      expect(calls[1]!.cmd.slice(0, 3)).toEqual(["fly", "machine", "run"]);
      expect(calls[1]!.cmd).toContain("--rm");
      expect(calls[calls.length - 1]!.cmd).toEqual(["fly", "apps", "destroy", "vibehard-exec-test", "--yes"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing command → ok:false with the captured log, STILL torn down", async () => {
    const dir = workspace();
    try {
      const { runner, calls } = capturingRunner({ exitCode: 1, stderr: "Module not found: foo\n" });
      const r = await runInFlyExecSandbox(dir, "FROM node:20-alpine\n", ["sh", "-c", "npm run build"], baseDeps(runner));
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(1);
      expect(r.log).toContain("Module not found");
      expect(calls.some((c) => c.cmd[1] === "apps" && c.cmd[2] === "destroy")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("token via ENV not argv, resource cap present, ephemeral Dockerfile cleaned up after", async () => {
    const dir = workspace();
    try {
      const { runner, calls } = capturingRunner();
      await runInFlyExecSandbox(dir, "FROM node:20-alpine\n", ["sh", "-c", "npm run build"], baseDeps(runner));
      expect(calls.flatMap((c) => c.cmd)).not.toContain("fly-secret"); // token never in argv
      expect(calls.every((c) => c.env?.FLY_API_TOKEN === "fly-secret")).toBe(true);
      expect(calls[1]!.cmd).toContain("--vm-memory");
      expect(existsSync(join(dir, "Dockerfile.vibehard-sandbox"))).toBe(false); // written-then-removed, no leftover
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no FLY_API_TOKEN → ok:false immediately, no Fly calls at all", async () => {
    const dir = workspace();
    try {
      const { runner, calls } = capturingRunner();
      const r = await runInFlyExecSandbox(dir, "FROM node:20-alpine\n", ["sh", "-c", "npm run build"], { runner, token: "" });
      expect(r.ok).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an exception mid-run (e.g. machine run throws) → ok:false, teardown still attempted", async () => {
    const dir = workspace();
    let torndown = false;
    const runner: CommandRunner = {
      run: async (cmd) => {
        if (cmd[1] === "apps" && cmd[2] === "destroy") {
          torndown = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd[1] === "machine") throw new Error("network blip");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    try {
      const r = await runInFlyExecSandbox(dir, "FROM node:20-alpine\n", ["sh", "-c", "npm run build"], { runner, token: "t", name: () => "x" });
      expect(r.ok).toBe(false);
      expect(r.log).toContain("network blip");
      expect(torndown).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
