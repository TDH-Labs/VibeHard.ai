import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLaunch, findEntry, summarizeBuild, summarizeVerify } from "./verify.ts";
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
