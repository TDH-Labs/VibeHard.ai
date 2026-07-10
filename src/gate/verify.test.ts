import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectLaunch,
  dockerTag,
  dummyEnvValue,
  findEntry,
  installStale,
  pythonStartCommand,
  isUp,
  parseEnvKeys,
  resolveSandboxHost,
  runVerify,
  safeToolEnv,
  summarizeBuild,
  summarizeBuildArtifacts,
  summarizeSandbox,
  summarizeShutdown,
  summarizeVerify,
  synthEnv,
  synthVerifyDockerfile,
  verifyRuns,
} from "./verify.ts";
import { verdictOf } from "../types.ts";
import type { HostProvider } from "../substrate/types.ts";
import { FlyHostProvider } from "../substrate/fly.ts";
import type { CommandResult, CommandRunner } from "../substrate/vercel.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures");

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function scratch(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "vibehard-verify-"));
  tmps.push(d);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(d, path), content);
  return d;
}

describe("installStale (auto-fix loop's reinstall signal)", () => {
  test("no node_modules → stale (fresh generated app)", async () => {
    const d = await scratch({ "package.json": JSON.stringify({ dependencies: { zod: "^3" } }) });
    expect(installStale(d)).toBe(true);
  });

  test("node_modules with no install stamp → stale (can't prove current)", async () => {
    const d = await scratch({
      "package.json": JSON.stringify({ dependencies: { zod: "^3" } }),
      "node_modules/zod/index.js": "",
    });
    expect(installStale(d)).toBe(true);
  });

  test("package.json newer than the install stamp → stale (a dep was just added)", async () => {
    const d = await scratch({
      "node_modules/.package-lock.json": "{}",
      "package.json": JSON.stringify({ dependencies: { zod: "^3", svix: "^1" } }),
    });
    // write the stamp FIRST, then bump package.json's mtime to "now" so it's newer
    await Bun.write(join(d, "node_modules/.package-lock.json"), "{}");
    await new Promise((r) => setTimeout(r, 12));
    await Bun.write(join(d, "package.json"), JSON.stringify({ dependencies: { zod: "^3", svix: "^1" } }));
    expect(installStale(d)).toBe(true);
  });

  test("install stamp newer than package.json → fresh (no reinstall)", async () => {
    const d = await scratch({ "package.json": JSON.stringify({ dependencies: { zod: "^3" } }) });
    await new Promise((r) => setTimeout(r, 12));
    await Bun.write(join(d, "node_modules/.package-lock.json"), "{}");
    expect(installStale(d)).toBe(false);
  });
});

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

  test("audit2 B4: a healthy / → /login resolves to 200 (fetch follows redirects) and passes", () => {
    // In production the probe's `fetch` follows the redirect, so a healthy redirecting app records 200.
    expect(summarizeVerify([{ run: 1, status: 200 }, { run: 2, status: 200 }, { run: 3, status: 200 }], 3)).toEqual([]);
  });

  test("audit2 B4: a status still 3xx after following (broken/looping redirect) is NOT up → blocks", () => {
    const runs = [
      { run: 1, status: 302 },
      { run: 2, status: 302 },
      { run: 3, status: 302 },
    ];
    expect(summarizeVerify(runs, 3).length).toBeGreaterThan(0);
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

describe("verifyRuns — §18 adaptive rigor (1 / 3 / 5)", () => {
  test("prototype → 1, production → 5, unknown → 3 (all-N-green is required by the loop)", () => {
    expect(verifyRuns("prototype")).toBe(1);
    expect(verifyRuns("production")).toBe(5);
    expect(verifyRuns(null)).toBe(3);
  });
});

describe("summarizeShutdown — §18 graceful shutdown (advisory)", () => {
  test("an app that came up but was force-killed → one MEDIUM advisory (not a block)", () => {
    const f = summarizeShutdown([
      { run: 1, status: 200, cleanShutdown: false },
      { run: 2, status: 200, cleanShutdown: true },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ ruleId: "unclean-shutdown", severity: "medium" });
  });

  test("clean shutdowns → no finding; and a down run's shutdown is irrelevant", () => {
    expect(summarizeShutdown([{ run: 1, status: 200, cleanShutdown: true }])).toEqual([]);
    expect(summarizeShutdown([{ run: 1, status: 0, cleanShutdown: false }])).toEqual([]); // never came up → n/a
  });
});

describe("isUp (pure probe predicate)", () => {
  test("audit2 B4: only 2xx is up; a leftover 3xx (broken/looping redirect) and 4xx/5xx/0 are not", () => {
    for (const s of [200, 201, 204, 299]) expect(isUp(s)).toBe(true);
    for (const s of [0, 301, 302, 308, 399, 400, 401, 404, 500, 503]) expect(isUp(s)).toBe(false);
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
    expect(dummyEnvValue("SESSION_SECRET")).toBe("vibehard-verify-placeholder");
    expect(dummyEnvValue("SUPABASE_ANON_KEY")).toBe("vibehard-verify-placeholder");
  });

  test("synthEnv unions keys across sources and is null-safe", () => {
    const env = synthEnv(["SUPABASE_URL=\nA_KEY=x", null, undefined, "PORT="]);
    expect(env).toEqual({
      SUPABASE_URL: "http://localhost:54321",
      A_KEY: "vibehard-verify-placeholder",
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

  test("a FastAPI app (requirements.txt + main.py) → python kind (uvicorn)", async () => {
    const dir = await scratch({ "requirements.txt": "fastapi\nuvicorn\nsupabase", "main.py": "app = FastAPI()" });
    expect(detectLaunch(dir)).toEqual({ kind: "python", cmd: ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "$PORT"] });
  });

  test("a Flask app (requirements.txt + app.py, no uvicorn) → python kind (python entry)", async () => {
    const dir = await scratch({ "requirements.txt": "flask\nsupabase", "app.py": "app = Flask(__name__)" });
    expect(detectLaunch(dir)).toEqual({ kind: "python", cmd: ["python", "app.py"] });
  });

  test("a node entry wins over a python app when both are present", async () => {
    const dir = await scratch({ "server.js": "x", "requirements.txt": "fastapi", "main.py": "y" });
    expect(detectLaunch(dir)).toEqual({ kind: "node", entry: "server.js" });
  });

  test("a Dockerfile → container kind (verify the deploy artifact)", async () => {
    const dir = await scratch({ Dockerfile: "FROM python:3.12-slim", "main.py": "x", "requirements.txt": "fastapi" });
    expect(detectLaunch(dir)).toEqual({ kind: "container" });
  });

  test("a Dockerfile wins over node/python (it's what actually ships)", async () => {
    const dir = await scratch({ Dockerfile: "FROM node:20", "server.js": "x", "package.json": "{}" });
    expect(detectLaunch(dir)).toEqual({ kind: "container" });
  });

  test("nothing launchable → null", async () => {
    const dir = await scratch({ "README.md": "# hi" });
    expect(detectLaunch(dir)).toBeNull();
  });
});

describe("detectLaunch — deployTarget: downloadable-tool (a CLI/script, not a server)", () => {
  test("a node entry + persisted deployTarget downloadable-tool → cli kind, not node", async () => {
    const dir = await scratch({
      "cli.js": "console.log('hi')",
      "package.json": '{"main":"cli.js"}',
      ".vibehard/spec.json": JSON.stringify({ deployTarget: "downloadable-tool" }),
    });
    expect(detectLaunch(dir)).toEqual({ kind: "cli", entry: "cli.js" });
  });

  test("a node entry + persisted deployTarget hosted-app → still node kind (unchanged)", async () => {
    const dir = await scratch({
      "server.js": "require('http')",
      "package.json": '{"main":"server.js"}',
      ".vibehard/spec.json": JSON.stringify({ deployTarget: "hosted-app" }),
    });
    expect(detectLaunch(dir)).toEqual({ kind: "node", entry: "server.js" });
  });

  test("a node entry with no persisted spec at all → node kind (missing deployTarget stays the strict default)", async () => {
    const dir = await scratch({ "server.js": "require('http')", "package.json": "{}" });
    expect(detectLaunch(dir)).toEqual({ kind: "node", entry: "server.js" });
  });

  test("2026-07-09: a downloadable-tool with a stray Dockerfile does NOT go through the container path — falls through to cli", async () => {
    // Belt-and-suspenders regression: a real dogfooding run had the architecture stage generate
    // a Dockerfile for a declared downloadable-tool (a separate, now-fixed bug upstream); this
    // caused verify to spin up a real ephemeral Fly sandbox to boot-test a container that was
    // never meant to be deployed, and fail. A stray Dockerfile must never route a downloadable
    // tool into the container/fly-sandbox path — the architecture gate catches the stray
    // Dockerfile itself (downloadable-tool-uses-hosted-stack); verify's job is just to check
    // whatever entry point actually exists.
    const dir = await scratch({
      Dockerfile: "FROM node:20",
      "cli.js": "x",
      "package.json": '{"main":"cli.js"}',
      ".vibehard/spec.json": JSON.stringify({ deployTarget: "downloadable-tool" }),
    });
    expect(detectLaunch(dir)).toEqual({ kind: "cli", entry: "cli.js" });
  });

  test("a hosted-app Dockerfile still wins unconditionally (unchanged regression)", async () => {
    const dir = await scratch({
      Dockerfile: "FROM node:20",
      "server.js": "require('http')",
      "package.json": '{"main":"server.js"}',
      ".vibehard/spec.json": JSON.stringify({ deployTarget: "hosted-app" }),
    });
    expect(detectLaunch(dir)).toEqual({ kind: "container" });
  });
});

describe("dockerTag (pure)", () => {
  test("a deterministic, docker-safe tag from the dir name", () => {
    expect(dockerTag("/tmp/My App!")).toBe("vibehard-verify-my-app");
    expect(dockerTag("/work/notes-api")).toBe("vibehard-verify-notes-api");
  });
});

describe("pythonStartCommand (pure)", () => {
  test("FastAPI/uvicorn deps → uvicorn <module>:app", () => {
    expect(pythonStartCommand("main.py", "fastapi==0.110\nuvicorn[standard]")).toEqual(["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "$PORT"]);
  });
  test("Flask / plain deps → python entry (reads PORT from env)", () => {
    expect(pythonStartCommand("app.py", "flask\nsupabase")).toEqual(["python", "app.py"]);
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

describe("safeToolEnv — CRITICAL-2: platform secrets must not leak into generated-code subprocess env", () => {
  test("does not include secrets from process.env", async () => {
    const dir = await scratch({ ".env.example": "DATABASE_URL=dummy\n" });
    const saved = { ...process.env };
    process.env.OPENCODE_API_KEY = "sk-test-secret-leaked";
    process.env.FLY_API_TOKEN = "fly-secret-leaked";
    process.env.ANTHROPIC_API_KEY = "anthropic-secret-leaked";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "supabase-secret-leaked";
    try {
      const env = safeToolEnv(dir);
      expect(env.OPENCODE_API_KEY).toBeUndefined();
      expect(env.FLY_API_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    } finally {
      Object.assign(process.env, saved);
      for (const k of ["OPENCODE_API_KEY", "FLY_API_TOKEN", "ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
        if (!(k in saved)) delete process.env[k];
      }
    }
  });

  test("does include allowlisted toolchain vars and synthetic app dummies", async () => {
    const dir = await scratch({ ".env.example": "DATABASE_URL=dummy\n" });
    const env = safeToolEnv(dir);
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
    expect(env.DATABASE_URL).toBeDefined(); // synthEnv dummy
    expect(env.DATABASE_URL).not.toBe(""); // has a placeholder, not empty
  });
});

describe("resolveSandboxHost — the container path's isolation gating (EPIC #32a)", () => {
  const fakeHost: HostProvider = {
    name: "fake-fly",
    deploy: async () => ({ url: "https://fake.example", hostRef: "fake-ref" }),
    teardown: async () => {},
  };
  const saved = process.env.FLY_API_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.FLY_API_TOKEN;
    else process.env.FLY_API_TOKEN = saved;
  });

  test("an injected host ALWAYS wins, regardless of FLY_API_TOKEN (tests/callers never touch real Fly)", () => {
    delete process.env.FLY_API_TOKEN;
    expect(resolveSandboxHost(fakeHost)).toBe(fakeHost);
    process.env.FLY_API_TOKEN = "some-token";
    expect(resolveSandboxHost(fakeHost)).toBe(fakeHost); // still the injected one, not a real FlyHostProvider
  });

  test("no injected host + no FLY_API_TOKEN → undefined (falls back to local docker, today's behavior)", () => {
    delete process.env.FLY_API_TOKEN;
    expect(resolveSandboxHost(undefined)).toBeUndefined();
  });

  test("no injected host + FLY_API_TOKEN set → a real FlyHostProvider (constructing it does no I/O)", () => {
    process.env.FLY_API_TOKEN = "some-token";
    const host = resolveSandboxHost(undefined);
    expect(host).toBeInstanceOf(FlyHostProvider);
    expect(host?.name).toBe("fly");
  });
});

describe("summarizeSandbox — a Fly-sandboxed container result → findings (EPIC #32a)", () => {
  test("ok → no findings (pass)", () => {
    expect(summarizeSandbox({ ok: true, status: 200, url: "https://x", log: "" })).toEqual([]);
  });

  test("not ok → one high-severity finding carrying the log tail", () => {
    const findings = summarizeSandbox({ ok: false, status: 0, url: null, log: "boot crashed: ECONNREFUSED" });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.ruleId).toBe("sandbox-boot-failed");
    expect(findings[0]!.message).toContain("ECONNREFUSED");
  });
});

describe("summarizeBuildArtifacts — an exit-0 build must leave evidence (SECURITY_AUDIT_4)", () => {
  test("no output dir, nothing written since the build started → blocking finding", async () => {
    const d = await scratch({ "package.json": JSON.stringify({ scripts: { build: "true" } }) });
    // everything in `d` predates `startedMs` → the no-op `"build": "true"` leaves no evidence
    const f = summarizeBuildArtifacts(d, Date.now() + 5);
    expect(f?.ruleId).toBe("build-no-artifacts");
    expect(f?.severity).toBe("high");
  });

  test("a non-empty conventional output dir (dist/) → null, even with old mtimes (cached rebuilds)", async () => {
    const d = await scratch({ "package.json": "{}", "dist/index.html": "<html>ok</html>" });
    expect(summarizeBuildArtifacts(d, Date.now() + 5)).toBeNull();
  });

  test("a file written during the build → null (covers custom outDirs)", async () => {
    const d = await scratch({ "package.json": "{}" });
    const startedMs = Date.now() - 1;
    await Bun.write(join(d, "custom-out", "bundle.js"), "console.log(1)");
    expect(summarizeBuildArtifacts(d, startedMs)).toBeNull();
  });

  test("changes inside node_modules don't count as artifacts", async () => {
    const d = await scratch({ "package.json": "{}" });
    const startedMs = Date.now() + 5;
    await Bun.write(join(d, "node_modules", "x", "index.js"), "x");
    expect(summarizeBuildArtifacts(d, startedMs)?.ruleId).toBe("build-no-artifacts");
  });
});

describe("synthVerifyDockerfile — EPIC #32 minimal image for the build/node sandboxed paths", () => {
  test("installs deps, exposes 8080, CMDs the given entry", () => {
    const d = synthVerifyDockerfile("server.js");
    expect(d).toContain("FROM node:20-alpine");
    expect(d).toContain("RUN npm install --no-audit --no-fund");
    expect(d).toContain("EXPOSE 8080");
    expect(d).toContain('ENV PORT=8080');
    expect(d).toContain('CMD ["node", "server.js"]');
  });

  test("null entry (build-only — the exec sandbox always overrides the command) → still valid Dockerfile syntax", () => {
    const d = synthVerifyDockerfile(null);
    expect(d).toContain('CMD ["node", "--version"]');
  });
});

function fakeHostProvider(over: Partial<HostProvider> = {}): HostProvider {
  return {
    name: "fake-fly",
    deploy: async (_w, _e, ref) => ({ url: "https://sbx.fly.dev", hostRef: ref ?? "sbx" }),
    teardown: async () => {},
    ...over,
  };
}
function fakeExecRunner(result: Partial<CommandResult> = {}) {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run: async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "", ...result };
    },
  };
  return { runner, calls };
}

describe("runVerify — build kind, EPIC #32 sandboxed exec path", () => {
  test("a Fly host configured → runs in the exec sandbox, never touches host npm/local runBuild", async () => {
    const d = await scratch({ "package.json": JSON.stringify({ scripts: { build: "vite build" } }) });
    const { runner, calls } = fakeExecRunner({ exitCode: 0, stdout: "built\n" });
    const v = await runVerify(d, undefined, {
      flyHost: fakeHostProvider(),
      flyExec: { runner, token: "t", name: () => "vibehard-exec-test" },
    });
    expect(v.findings).toEqual([]); // pass, no findings
    expect(calls.some((c) => c[1] === "machine" && c[2] === "run")).toBe(true);
    // never fell through to a local `npm run build` on the host — no dist/ was produced locally
    expect(existsSync(join(d, "dist"))).toBe(false);
  });

  test("the sandboxed build fails → a build-failed finding carrying the sandbox's log", async () => {
    const d = await scratch({ "package.json": JSON.stringify({ scripts: { build: "vite build" } }) });
    const { runner } = fakeExecRunner({ exitCode: 1, stderr: "Module not found: foo\n" });
    const v = await runVerify(d, undefined, {
      flyHost: fakeHostProvider(),
      flyExec: { runner, token: "t", name: () => "vibehard-exec-test" },
    });
    expect(v.findings.length).toBeGreaterThan(0);
    expect(v.findings.some((f) => f.message.includes("Module not found"))).toBe(true);
  });

  test("2026-07-09: the SANDBOX'S OWN image build fails (before npm run build ever ran) → a distinct, accurately-labeled finding, not a misleading 'npm run build exited' one", async () => {
    // Real captured incident: the Dockerfile's own baked-in `RUN npm install` step failed, but
    // the resulting finding claimed "`npm run build` exited 1" — npm run build never even ran.
    const d = await scratch({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) });
    const buildkitLog =
      "load build definition from dockerfile: 209B 0.2s done\n#1 DONE 0.2s\n\n#2 [internal] load .dockerignore\n" +
      "Error: error building: failed to solve: process \"/bin/sh -c npm install --no-audit --no-fund\" did not complete successfully: exit code: 1";
    const { runner } = fakeExecRunner({ exitCode: 1, stderr: buildkitLog });
    const v = await runVerify(d, undefined, {
      flyHost: fakeHostProvider(),
      flyExec: { runner, token: "t", name: () => "vibehard-exec-test" },
    });
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]?.ruleId).toBe("sandbox-image-build-failed");
    expect(v.findings[0]?.file).toBe("Dockerfile");
    expect(v.findings[0]?.message).not.toContain("npm run build` exited"); // not misattributed to the app's own script
    expect(v.findings[0]?.message).toContain("before `npm run build` ever ran");
    expect(v.findings[0]?.message).toContain("failed to solve");
  });

  test("no Fly host configured → resolveSandboxHost returns undefined, falling through unchanged", () => {
    // Structural, not behavioral: with no flyHost/token, `resolveSandboxHost(deps.flyHost)` in the
    // build branch is falsy, so execution falls through past the new `if (flyHost) {...; return}`
    // block to the exact pre-existing `runBuild` call below it — unmodified code, already covered
    // by this file's other build-kind tests (e.g. summarizeBuildArtifacts, "true" script). A real
    // `npm run build` invocation here is redundant coverage AND flaky in this sandboxed test env
    // (npm's own startup network check hangs with no outbound access) — resolveSandboxHost's own
    // gating logic already has dedicated tests above.
    //
    // Bun auto-loads .env for every `bun` invocation (including `bun test`), so a real
    // FLY_API_TOKEN can be live in process.env here — must clear it first, same as the
    // `resolveSandboxHost` describe block above.
    const saved = process.env.FLY_API_TOKEN;
    delete process.env.FLY_API_TOKEN;
    try {
      expect(resolveSandboxHost(undefined)).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.FLY_API_TOKEN;
      else process.env.FLY_API_TOKEN = saved;
    }
  });
});

describe("runVerify — cli kind (downloadable-tool), EPIC #32 sandboxed exec path (2026-07-09)", () => {
  // Until now the `cli` launch kind (deployTarget: downloadable-tool) had NO sandbox wiring at
  // all, regardless of whether a Fly host was configured — the one launch kind that always ran
  // untrusted install+run directly on the platform host. This closes that gap.
  test("a Fly host configured → runs `node <entry>` in the exec sandbox, never touches host npm", async () => {
    const d = await scratch({
      "package.json": JSON.stringify({ main: "src/index.js", dependencies: { commander: "^12" } }),
      "src/index.js": "console.log('ok')",
      ".vibehard/spec.json": JSON.stringify({ deployTarget: "downloadable-tool" }),
    });
    const { runner, calls } = fakeExecRunner({ exitCode: 0, stdout: "ok\n" });
    const v = await runVerify(d, undefined, {
      flyHost: fakeHostProvider(),
      flyExec: { runner, token: "t", name: () => "vibehard-exec-test" },
    });
    expect(v.findings).toEqual([]); // pass, no findings
    expect(calls.some((c) => c[1] === "machine" && c[2] === "run" && c.includes("node") && c.includes("src/index.js"))).toBe(true);
    expect(existsSync(join(d, "node_modules"))).toBe(false); // never fell through to a local install
  });

  test("the sandboxed run fails → a cli-run-failed finding, the SAME shape the local path produces", async () => {
    const d = await scratch({
      "package.json": JSON.stringify({ main: "src/index.js" }),
      "src/index.js": "process.exit(1)",
      ".vibehard/spec.json": JSON.stringify({ deployTarget: "downloadable-tool" }),
    });
    const { runner } = fakeExecRunner({ exitCode: 1, stderr: "boom\n" });
    const v = await runVerify(d, undefined, {
      flyHost: fakeHostProvider(),
      flyExec: { runner, token: "t", name: () => "vibehard-exec-test" },
    });
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]?.ruleId).toBe("cli-run-failed");
    expect(v.findings[0]?.message).toContain("boom");
  });

  test("2026-07-09: the sandbox's own image build fails (before node <entry> ever ran) → sandbox-image-build-failed, not a misleading cli-run-failed", async () => {
    const d = await scratch({
      "package.json": JSON.stringify({ main: "src/index.js" }),
      "src/index.js": "console.log('ok')",
      ".vibehard/spec.json": JSON.stringify({ deployTarget: "downloadable-tool" }),
    });
    const buildkitLog = "load build definition from dockerfile: 209B 0.2s done\nError: error building: failed to solve: process \"/bin/sh -c npm install --no-audit --no-fund\" did not complete successfully: exit code: 1";
    const { runner } = fakeExecRunner({ exitCode: 1, stderr: buildkitLog });
    const v = await runVerify(d, undefined, {
      flyHost: fakeHostProvider(),
      flyExec: { runner, token: "t", name: () => "vibehard-exec-test" },
    });
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]?.ruleId).toBe("sandbox-image-build-failed");
    expect(v.findings[0]?.message).not.toContain("cli tool did not run cleanly");
    expect(v.findings[0]?.message).toContain("before `node src/index.js` ever ran");
  });
});

describe("runVerify — node kind, EPIC #32 sandboxed deploy path", () => {
  test("a Fly host configured → deploys+probes the sandbox, and the synthesized Dockerfile never lingers", async () => {
    const d = await scratch({ "server.js": "require('http').createServer((_,r)=>r.end('ok')).listen(process.env.PORT)" });
    const v = await runVerify(d, undefined, {
      flyHost: fakeHostProvider(),
      flySandboxFetch: async () => ({ status: 200 }), // the sandbox's own HTTP probe — never a real network call in tests
    });
    expect(v.findings).toEqual([]); // fakeHostProvider's deploy + a healthy fake probe → pass
    expect(existsSync(join(d, "Dockerfile"))).toBe(false); // transient — cleaned up after
  });

  test("the sandboxed deploy comes up but serves unhealthy → sandbox-boot-failed, Dockerfile still cleaned up", async () => {
    const d = await scratch({ "server.js": "console.log('x')" });
    const v = await runVerify(d, undefined, {
      flyHost: fakeHostProvider(),
      flySandboxFetch: async () => ({ status: 502 }),
    });
    expect(v.findings.some((f) => f.ruleId === "sandbox-boot-failed")).toBe(true);
    expect(existsSync(join(d, "Dockerfile"))).toBe(false);
  });

  test("Dockerfile is cleaned up even when the sandboxed deploy throws", async () => {
    const d = await scratch({ "server.js": "console.log('x')" });
    const v = await runVerify(d, undefined, {
      flyHost: fakeHostProvider({ deploy: async () => { throw new Error("fly deploy failed"); } }),
    });
    expect(v.findings.some((f) => f.ruleId === "sandbox-boot-failed")).toBe(true);
    expect(existsSync(join(d, "Dockerfile"))).toBe(false);
  });
});
