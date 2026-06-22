import { describe, expect, test } from "bun:test";
import { firstVercelUrl, sanitizeProjectName, VercelHostProvider, type CommandResult, type CommandRunner } from "./vercel.ts";

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

describe("pure helpers", () => {
  test("sanitizeProjectName — lowercase, valid chars, no '---' run, trimmed", () => {
    expect(sanitizeProjectName("My App!")).toBe("my-app");
    expect(sanitizeProjectName("a   b---c")).toBe("a-b-c"); // runs + '---' collapsed
    expect(sanitizeProjectName("--Trim__Me--")).toBe("trim__me");
  });
  test("firstVercelUrl finds the deployment URL, else null", () => {
    expect(firstVercelUrl("noise", "Production: https://a-b.vercel.app [2s]")).toBe("https://a-b.vercel.app");
    expect(firstVercelUrl("nothing here")).toBeNull();
  });
});

describe("VercelHostProvider.deploy", () => {
  test("assembles args, passes the token via ENV not argv, parses the URL, derives hostRef", async () => {
    const { runner, calls } = capturingRunner({ stdout: "https://myapp-abc.vercel.app\n" });
    const p = new VercelHostProvider({ token: "tok-secret", scope: "", runner });
    const out = await p.deploy("/work/myapp", { SUPABASE_URL: "u", SUPABASE_ANON_KEY: "a" }, null);

    expect(out.url).toBe("https://myapp-abc.vercel.app");
    expect(out.hostRef).toBe("myapp"); // from the workspace basename
    expect(calls[0]!.cmd).toEqual(["bunx", "vercel", "deploy", "--yes", "--name", "myapp", "--prod", "-e", "SUPABASE_URL=u", "-e", "SUPABASE_ANON_KEY=a"]);
    expect(calls[0]!.cmd).not.toContain("tok-secret"); // token NEVER in argv
    expect(calls[0]!.env?.VERCEL_TOKEN).toBe("tok-secret"); // …passed via env
    expect(calls[0]!.cwd).toBe("/work/myapp");
  });

  test("only the env handed in is injected (service key never reaches here by construction)", async () => {
    const { runner, calls } = capturingRunner({ stdout: "https://x.vercel.app" });
    await new VercelHostProvider({ token: "t", runner }).deploy("/w/app", { SUPABASE_URL: "u", SUPABASE_ANON_KEY: "a" }, null);
    const flags = calls[0]!.cmd.filter((a) => a.startsWith("SUPABASE_"));
    expect(flags).toEqual(["SUPABASE_URL=u", "SUPABASE_ANON_KEY=a"]);
    expect(calls[0]!.cmd.some((a) => /SERVICE_ROLE/.test(a))).toBe(false);
  });

  test("a team scope is passed as --scope (required for team tokens in non-interactive mode)", async () => {
    const { runner, calls } = capturingRunner({ stdout: "https://x.vercel.app" });
    await new VercelHostProvider({ token: "t", scope: "tdh-labs", runner }).deploy("/w/app", {}, null);
    expect(calls[0]!.cmd).toContain("--scope");
    expect(calls[0]!.cmd[calls[0]!.cmd.indexOf("--scope") + 1]).toBe("tdh-labs");
  });

  test("reuses a prior hostRef (idempotent redeploy)", async () => {
    const { runner } = capturingRunner({ stdout: "https://x.vercel.app" });
    expect((await new VercelHostProvider({ token: "t", runner }).deploy("/w/app", {}, "existing-project")).hostRef).toBe("existing-project");
  });

  test("a non-zero exit throws with the stderr", async () => {
    const { runner } = capturingRunner({ exitCode: 1, stderr: "build blew up" });
    await expect(new VercelHostProvider({ token: "t", runner }).deploy("/w/app", {}, null)).rejects.toThrow(/build blew up/);
  });

  test("a deploy with no URL in the output throws", async () => {
    const { runner } = capturingRunner({ stdout: "nothing useful here" });
    await expect(new VercelHostProvider({ token: "t", runner }).deploy("/w/app", {}, null)).rejects.toThrow(/no deployment URL/);
  });

  test("missing token throws before running anything", async () => {
    const { runner, calls } = capturingRunner();
    await expect(new VercelHostProvider({ token: "", runner }).deploy("/w/app", {}, null)).rejects.toThrow(/VERCEL_TOKEN/);
    expect(calls).toHaveLength(0);
  });
});

describe("VercelHostProvider.teardown", () => {
  test("removes the project by hostRef, token via env", async () => {
    const { runner, calls } = capturingRunner();
    await new VercelHostProvider({ token: "t", scope: "", runner }).teardown("my-proj");
    expect(calls[0]!.cmd).toEqual(["bunx", "vercel", "remove", "my-proj", "--yes"]);
    expect(calls[0]!.env?.VERCEL_TOKEN).toBe("t");
  });
});
