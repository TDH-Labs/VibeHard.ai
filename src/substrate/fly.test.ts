import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlyHostProvider, isPublicEnvVar, partitionEnv, renderFlyToml } from "./fly.ts";
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

  test("a long deploy log keeps the REAL error at the end, not early BuildKit progress noise (found live 2026-07-10: a genuine TS compile error was invisible to both the human reviewer and the autofix loop's own fixer because the old slice(0, 400) only ever captured the head)", async () => {
    const dir = workspaceWithDockerfile();
    try {
      const noise = "#1 [internal] load build definition from Dockerfile\n".repeat(50); // > 400 chars of pure progress lines
      const realError = "Type error: Type 'string | ActionFailure' is not assignable to type 'object'.";
      const { runner } = capturingRunner({ exitCode: 1, stderr: noise + realError });
      await expect(new FlyHostProvider({ token: "t", runner }).deploy(dir, {}, null)).rejects.toThrow(new RegExp(realError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pins PORT to the internal port in [env] — the deploy contract (e2e-9 root cause, found live 2026-07-13: fly.toml routed traffic to internal_port 8080 but nothing ever told the app, so a generated Dockerfile's ENV PORT=3000 booted a healthy app no probe could reach — 502 on every fix attempt)", async () => {
    const dir = workspaceWithDockerfile();
    try {
      const { runner, calls } = capturingRunner();
      await new FlyHostProvider({ token: "t", runner }).deploy(dir, {}, null);
      const toml = calls.find((c) => c.cmd.includes("deploy"))!.flyToml ?? "";
      expect(toml).toContain('PORT = "8080"');
      expect(toml).toContain("internal_port = 8080"); // …and it matches where traffic is routed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a caller-supplied PORT is overridden, not honored — synthEnv dummies a declared PORT as '3000', exactly the value that recreates the routed-port mismatch", async () => {
    const dir = workspaceWithDockerfile();
    try {
      const { runner, calls } = capturingRunner();
      await new FlyHostProvider({ token: "t", runner, internalPort: 8080 }).deploy(dir, { PORT: "3000" }, null);
      const toml = calls.find((c) => c.cmd.includes("deploy"))!.flyToml ?? "";
      expect(toml).toContain('PORT = "8080"');
      expect(toml).not.toContain('"3000"');
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

describe("partitionEnv / isPublicEnvVar — HIGH-6: third-party secrets must not appear in plaintext fly.toml", () => {
  test("NEXT_PUBLIC_* and VITE_* are public (intentionally in browser bundle)", () => {
    expect(isPublicEnvVar("NEXT_PUBLIC_SUPABASE_URL")).toBe(true);
    expect(isPublicEnvVar("VITE_STRIPE_PK")).toBe(true);
  });

  test("SUPABASE_URL and SUPABASE_ANON_KEY are public", () => {
    expect(isPublicEnvVar("SUPABASE_URL")).toBe(true);
    expect(isPublicEnvVar("SUPABASE_ANON_KEY")).toBe(true);
  });

  test("STRIPE_SECRET_KEY and API tokens are secrets (never in [env])", () => {
    expect(isPublicEnvVar("STRIPE_SECRET_KEY")).toBe(false);
    expect(isPublicEnvVar("STRIPE_WEBHOOK_SECRET")).toBe(false);
    expect(isPublicEnvVar("FLY_API_TOKEN")).toBe(false);
    expect(isPublicEnvVar("OPENAI_API_KEY")).toBe(false);
    expect(isPublicEnvVar("SUPABASE_SERVICE_ROLE_KEY")).toBe(false);
  });

  test("partitionEnv splits correctly", () => {
    const env = {
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
      STRIPE_SECRET_KEY: "sk_live_secret",
      STRIPE_WEBHOOK_SECRET: "whsec_secret",
    };
    const { publicEnv, secretEnv } = partitionEnv(env);
    expect(Object.keys(publicEnv)).toEqual(expect.arrayContaining(["SUPABASE_URL", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL"]));
    expect(Object.keys(publicEnv)).not.toContain("STRIPE_SECRET_KEY");
    expect(Object.keys(publicEnv)).not.toContain("STRIPE_WEBHOOK_SECRET");
    expect(secretEnv.STRIPE_SECRET_KEY).toBe("sk_live_secret");
    expect(secretEnv.STRIPE_WEBHOOK_SECRET).toBe("whsec_secret");
    expect(secretEnv.SUPABASE_URL).toBeUndefined();
  });

  test("FlyHostProvider.deploy sends secrets via fly secrets set, NOT in fly.toml", async () => {
    const dir = workspaceWithDockerfile();
    try {
      const { runner, calls } = capturingRunner();
      await new FlyHostProvider({ token: "t", runner }).deploy(
        dir,
        { SUPABASE_URL: "u", SUPABASE_ANON_KEY: "a", STRIPE_SECRET_KEY: "sk_live_secret" },
        null,
      );
      const deployCall = calls.find((c) => c.cmd.includes("deploy"))!;
      // Secret must NOT appear in fly.toml [env]
      expect(deployCall.flyToml ?? "").not.toContain("sk_live_secret");
      // Secret MUST be set via fly secrets set
      const secretsCall = calls.find((c) => c.cmd.includes("secrets") && c.cmd.includes("set"));
      expect(secretsCall).toBeDefined();
      expect(secretsCall!.cmd.join(" ")).toContain("STRIPE_SECRET_KEY=sk_live_secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
