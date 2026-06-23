import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlyHostProvider, renderFlyToml } from "./fly.ts";
import type { CommandResult, CommandRunner } from "./vercel.ts";

// Snapshot fly.toml AT each command call — the provider writes it for the duration of the deploy
// and removes it after, so the only place to observe its contents is while a fly command runs.
function capturingRunner(result: Partial<CommandResult> = {}) {
  const calls: Array<{ cmd: string[]; cwd: string; env?: Record<string, string>; flyToml?: string }> = [];
  const runner: CommandRunner = {
    run: async (cmd, opts) => {
      let flyToml: string | undefined;
      try {
        flyToml = readFileSync(join(opts.cwd, "fly.toml"), "utf8");
      } catch {
        /* fly.toml not present at this call */
      }
      calls.push({ cmd, cwd: opts.cwd, env: opts.env, flyToml });
      return { exitCode: 0, stdout: "", stderr: "", ...result };
    },
  };
  return { runner, calls };
}
function workspaceWithDockerfile(): string {
  const dir = mkdtempSync(join(tmpdir(), "dd-fly-"));
  writeFileSync(join(dir, "Dockerfile"), "FROM python:3.12-slim\nCMD [\"python\", \"app.py\"]\n");
  return dir;
}

describe("renderFlyToml", () => {
  test("app, region, quoted env, and an http service on the internal port", () => {
    const t = renderFlyToml("my-app", "iad", 8080, { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon" });
    expect(t).toContain('app = "my-app"');
    expect(t).toContain('primary_region = "iad"');
    expect(t).toContain('SUPABASE_URL = "https://x.supabase.co"');
    expect(t).toContain('SUPABASE_ANON_KEY = "anon"');
    expect(t).toContain("internal_port = 8080");
    expect(t).toContain("force_https = true");
  });
});

describe("FlyHostProvider.deploy", () => {
  test("writes fly.toml, runs create then deploy, token via ENV not argv, deterministic .fly.dev URL", async () => {
    const dir = workspaceWithDockerfile();
    try {
      const { runner, calls } = capturingRunner();
      const out = await new FlyHostProvider({ token: "fly-secret", runner }).deploy(dir, { SUPABASE_URL: "u", SUPABASE_ANON_KEY: "a" }, null);

      expect(out.url).toMatch(/^https:\/\/.+\.fly\.dev$/);
      expect(out.hostRef.length).toBeGreaterThan(0);
      expect(calls[1]!.flyToml).toContain('SUPABASE_ANON_KEY = "a"'); // env present in fly.toml AT deploy time
      expect(existsSync(join(dir, "fly.toml"))).toBe(false); // …and removed after — no secret-bearing manifest left behind
      expect(calls[0]!.cmd).toContain("create"); // create first (idempotent)
      expect(calls[1]!.cmd.slice(0, 2)).toEqual(["fly", "deploy"]);
      expect(calls[1]!.cmd).toContain("--remote-only"); // builds on Fly — no local Docker
      expect(calls.flatMap((c) => c.cmd)).not.toContain("fly-secret"); // token NEVER in argv
      expect(calls[1]!.env?.FLY_API_TOKEN).toBe("fly-secret"); // …passed via env
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("only the orchestrator's env reaches the app (no service-role key by construction)", async () => {
    const dir = workspaceWithDockerfile();
    try {
      const { runner, calls } = capturingRunner();
      await new FlyHostProvider({ token: "t", runner }).deploy(dir, { SUPABASE_URL: "u", SUPABASE_ANON_KEY: "a" }, null);
      const toml = calls.find((c) => c.cmd.includes("deploy"))!.flyToml ?? "";
      expect(toml).toContain('SUPABASE_ANON_KEY = "a"');
      expect(toml).not.toMatch(/SERVICE_ROLE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes fly.toml even when the deploy FAILS (no secret-bearing manifest lingers to trip the secrets gate)", async () => {
    const dir = workspaceWithDockerfile();
    try {
      const { runner } = capturingRunner({ exitCode: 1, stderr: "boom" });
      await expect(
        new FlyHostProvider({ token: "t", runner }).deploy(dir, { SUPABASE_ANON_KEY: "a" }, null),
      ).rejects.toThrow(/fly deploy failed/);
      expect(existsSync(join(dir, "fly.toml"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reuses a prior hostRef (idempotent redeploy)", async () => {
    const dir = workspaceWithDockerfile();
    try {
      expect((await new FlyHostProvider({ token: "t", runner: capturingRunner().runner }).deploy(dir, {}, "existing-app")).hostRef).toBe("existing-app");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no Dockerfile → throws (a container deploy needs one)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-fly-nodocker-"));
    try {
      await expect(new FlyHostProvider({ token: "t", runner: capturingRunner().runner }).deploy(dir, {}, null)).rejects.toThrow(/Dockerfile/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing token → throws before touching anything", async () => {
    await expect(new FlyHostProvider({ token: "", runner: capturingRunner().runner }).deploy("/nope", {}, null)).rejects.toThrow(/FLY_API_TOKEN/);
  });
});

describe("FlyHostProvider.teardown", () => {
  test("destroys the app by hostRef, token via env", async () => {
    const { runner, calls } = capturingRunner();
    await new FlyHostProvider({ token: "t", runner }).teardown("my-app");
    expect(calls[0]!.cmd).toEqual(["fly", "apps", "destroy", "my-app", "--yes"]);
    expect(calls[0]!.env?.FLY_API_TOKEN).toBe("t");
  });
});
