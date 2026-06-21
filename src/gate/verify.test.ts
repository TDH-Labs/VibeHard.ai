import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectLaunch,
  dummyEnvValue,
  findEntry,
  isUp,
  parseEnvKeys,
  summarizeBuild,
  summarizeVerify,
  synthEnv,
} from "./verify.ts";
import { verdictOf } from "../types.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures");

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function scratch(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "drydock-verify-"));
  tmps.push(d);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(d, path), content);
  return d;
}

describe("summarizeVerify (pure)", () => {
  test("all runs healthy → no findings", () => {
    const runs = [
      { run: 1, status: 200 },
      { run: 2, status: 200 },
      { run: 3, status: 200 },
    ];
    expect(summarizeVerify(runs, 3)).toEqual([]);
  });

  test("any non-200 run → one blocking finding", () => {
    const runs = [
      { run: 1, status: 200 },
      { run: 2, status: 500 },
      { run: 3, status: 200 },
    ];
    const f = summarizeVerify(runs, 3);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ tool: "verify", ruleId: "health-check-failed", severity: "high" });
    expect(verdictOf("verify", f, "2026-06-20T00:00:00.000Z").status).toBe("block");
  });

  test("app never came up (status 0) → blocking", () => {
    const runs = [
      { run: 1, status: 0 },
      { run: 2, status: 0 },
      { run: 3, status: 0 },
    ];
    expect(summarizeVerify(runs, 3)).toHaveLength(1);
  });

  test("a server that redirects / → /login (3xx) counts as up (no false block)", () => {
    const runs = [
      { run: 1, status: 302 },
      { run: 2, status: 200 },
      { run: 3, status: 302 },
    ];
    expect(summarizeVerify(runs, 3)).toEqual([]);
  });

  test("a boot crash is surfaced in the finding message (actionable for auto-fix)", () => {
    const runs = [
      { run: 1, status: 0, log: "ReferenceError: body is not defined\n  at views/layout.ejs:25" },
      { run: 2, status: 0, log: "ReferenceError: body is not defined\n  at views/layout.ejs:25" },
      { run: 3, status: 0, log: "ReferenceError: body is not defined\n  at views/layout.ejs:25" },
    ];
    const f = summarizeVerify(runs, 3);
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("body is not defined");
  });
});

describe("isUp (pure probe predicate)", () => {
  test("2xx and 3xx are up; 4xx/5xx and 0 are not", () => {
    for (const s of [200, 201, 204, 301, 302, 308, 399]) expect(isUp(s)).toBe(true);
    for (const s of [0, 400, 401, 404, 500, 503]) expect(isUp(s)).toBe(false);
  });
});

describe("parseEnvKeys / dummyEnvValue / synthEnv (pure)", () => {
  test("parseEnvKeys extracts names, ignoring comments, blanks, and export prefixes", () => {
    const content = [
      "# Supabase",
      "SUPABASE_URL=https://xyz.supabase.co",
      "SUPABASE_ANON_KEY=",
      "export SESSION_SECRET=changeme",
      "",
      "PORT = 3000",
      "not a var line",
    ].join("\n");
    expect(parseEnvKeys(content)).toEqual([
      "SUPABASE_URL",
      "SUPABASE_ANON_KEY",
      "SESSION_SECRET",
      "PORT",
    ]);
  });

  test("dummyEnvValue gives a real URL for URL-shaped keys, a placeholder otherwise", () => {
    expect(dummyEnvValue("SUPABASE_URL")).toMatch(/^https?:\/\//);
    expect(dummyEnvValue("DATABASE_URI")).toMatch(/^https?:\/\//);
    expect(dummyEnvValue("PORT")).toBe("3000");
    expect(dummyEnvValue("SESSION_SECRET")).toBe("drydock-verify-placeholder");
    expect(dummyEnvValue("SUPABASE_ANON_KEY")).toBe("drydock-verify-placeholder");
  });

  test("synthEnv unions keys across sources and is null-safe", () => {
    const env = synthEnv(["SUPABASE_URL=\nA_KEY=x", null, undefined, "PORT="]);
    expect(env).toEqual({
      SUPABASE_URL: "http://localhost:54321",
      A_KEY: "drydock-verify-placeholder",
      PORT: "3000",
    });
  });
});

describe("findEntry", () => {
  test("resolves package.json main for the fixtures", () => {
    expect(findEntry(join(FIXTURES, "remediated"))).toBe("server.js");
    expect(findEntry(join(FIXTURES, "vulnerable"))).toBe("server.js");
  });

  test("returns null when there is nothing to launch", () => {
    expect(findEntry(join(FIXTURES, "vulnerable", "supabase"))).toBeNull();
  });
});

describe("detectLaunch", () => {
  test("a node server (server.js) → node kind", async () => {
    const dir = await scratch({ "server.js": "require('http')", "package.json": "{}" });
    expect(detectLaunch(dir)).toEqual({ kind: "node", entry: "server.js" });
  });

  test("a node entry wins even when a build script is also present", async () => {
    const dir = await scratch({ "server.js": "x", "package.json": '{"scripts":{"build":"tsc"}}' });
    expect(detectLaunch(dir)).toEqual({ kind: "node", entry: "server.js" });
  });

  test("a static/SPA app (build script, no server) → build kind (no longer false-blocked)", async () => {
    const dir = await scratch({
      "package.json": '{"private":true,"scripts":{"dev":"vite","build":"vite build"}}',
      "index.html": "<!doctype html>",
    });
    expect(detectLaunch(dir)).toEqual({ kind: "build", script: "build" });
  });

  test("nothing launchable → null", async () => {
    const dir = await scratch({ "README.md": "# hi" });
    expect(detectLaunch(dir)).toBeNull();
  });
});

describe("summarizeBuild (pure)", () => {
  test("a clean build → no findings", () => {
    expect(summarizeBuild({ stage: "build", exitCode: 0 })).toEqual([]);
  });

  test("a failed build → one blocking build-failed finding", () => {
    const f = summarizeBuild({ stage: "build", exitCode: 1 });
    expect(f[0]).toMatchObject({ tool: "verify", ruleId: "build-failed", severity: "high" });
    expect(verdictOf("verify", f, "2026-06-21T00:00:00.000Z").status).toBe("block");
  });

  test("a failed install is attributed to install, not build", () => {
    expect(summarizeBuild({ stage: "install", exitCode: 1 })[0]).toMatchObject({ ruleId: "install-failed" });
  });
});
