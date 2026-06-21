/**
 * M2 end-to-end seam proof (PROJECT_BRIEF.md §13 + the M2 task): generate an app
 * THROUGH the engine seam into our workspace, then run it through the REAL deploy
 * gate. Vulnerable generated output must be refused at the deploy boundary; clean
 * output must reach the target. This is "the gate sits between generate and deploy"
 * exercised for real (semgrep + gitleaks containers, RLS check, launch probe).
 *
 * Guarded behind DRYDOCK_INTEGRATION (needs Docker + Node). Run with:
 *   DRYDOCK_INTEGRATION=1 bun test e2e.integration
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoltEngine, replayDriver } from "./bolt/engine.ts";
import { gatedDeploy, type DeployTarget } from "./deploy.ts";
import type { EngineConfig, EngineEvent } from "../types.ts";

const CONFIG: EngineConfig = { provider: "anthropic", model: "claude-opus-4-8" };
const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function workspace(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "drydock-e2e-"));
  tmps.push(d);
  return d;
}
async function drain(it: AsyncIterable<EngineEvent>): Promise<void> {
  for await (const _ of it) void _;
}
function spyTarget(): DeployTarget & { calls: number } {
  return {
    name: "spy",
    calls: 0,
    async deploy() {
      this.calls++;
      return { url: "https://spy.example/app" };
    },
  };
}

const PKG = (name: string) => `{"name":"${name}","version":"0.1.0","private":true,"main":"server.js"}`;

const CLEAN_SERVER = `const { createServer } = require("node:http");
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(404); res.end("not found");
});
server.listen(process.env.PORT || 3000);`;

const VULN_SERVER = `const { createServer } = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const STRIPE_SECRET_KEY = "sk_live_51HshlongLOVEABLEexampleSECRETkeyABCDEFG1234567890";
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") { res.writeHead(200); return res.end("{}"); }
  const name = url.searchParams.get("name") ?? "";
  const rows = db.prepare(\`SELECT * FROM users WHERE name = '\${name}'\`).all();
  res.writeHead(200); res.end(JSON.stringify(rows));
});
server.listen(process.env.PORT || 3000);`;

const VULN_MIGRATION = `create table public.profiles (id uuid primary key, ssn text);`;

function streamFor(files: Record<string, string>): string {
  const actions = Object.entries(files)
    .map(([path, content]) => `<boltAction type="file" filePath="${path}">${content}</boltAction>`)
    .join("");
  return `Here you go.<boltArtifact id="app" title="app">${actions}</boltArtifact>`;
}

const run = process.env.DRYDOCK_INTEGRATION ? describe : describe.skip;

run("generate → gate → deploy (real gate)", () => {
  test("vulnerable generated app is REFUSED at the deploy boundary", async () => {
    const dir = await workspace();
    const session = await new BoltEngine(
      replayDriver([
        streamFor({
          "server.js": VULN_SERVER,
          "package.json": PKG("vuln-app"),
          "supabase/migrations/0001_init.sql": VULN_MIGRATION,
        }),
      ]),
    ).startSession(dir, CONFIG);
    await drain(session.prompt("build me a client portal"));

    const target = spyTarget();
    const r = await gatedDeploy(dir, target);

    expect(r.deployed).toBe(false);
    expect(target.calls).toBe(0); // never reached the target
    const blocked = r.verdict.verdicts.filter((v) => v.status === "block").map((v) => v.gate);
    expect(blocked).toEqual(expect.arrayContaining(["sast", "secrets", "rls"]));
  }, 120_000);

  test("clean generated app PASSES the gate and reaches the target", async () => {
    const dir = await workspace();
    const session = await new BoltEngine(
      replayDriver([streamFor({ "server.js": CLEAN_SERVER, "package.json": PKG("clean-app") })]),
    ).startSession(dir, CONFIG);
    await drain(session.prompt("build me a health endpoint"));

    const target = spyTarget();
    const r = await gatedDeploy(dir, target);

    expect(r.deployed).toBe(true);
    expect(target.calls).toBe(1);
    expect(r.url).toBe("https://spy.example/app");
  }, 120_000);
});
