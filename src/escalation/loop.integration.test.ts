/**
 * M3 full hand-off loop, end to end with the REAL gate (PROJECT_BRIEF.md §8
 * "Option B"): generate a vulnerable app through the engine → gate BLOCKS the
 * deploy → build a routed, localized escalation packet → an engineer FIXES the
 * slice → resume RE-GATES and deploys. Proves the gate confirms the fix (the
 * human's word is never trusted) and the ratchet holds across the loop.
 *
 * Guarded behind VIBEHARD_INTEGRATION (Docker + Node). Run with:
 *   VIBEHARD_INTEGRATION=1 bun test loop.integration
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoltEngine, replayDriver } from "../engine/bolt/engine.ts";
import { gatedDeploy, type DeployTarget } from "../engine/deploy.ts";
import { buildEscalationPacket } from "./packet.ts";
import { resumeDeploy } from "./resume.ts";
import type { EngineConfig, EngineEvent } from "../types.ts";

const CONFIG: EngineConfig = { provider: "anthropic", model: "claude-opus-4-8" };
const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function workspace(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "vibehard-loop-"));
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

const PKG = '{"name":"portal","version":"0.1.0","private":true,"main":"server.js"}';
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
const FIXED_SERVER = `const { createServer } = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") { res.writeHead(200); return res.end("{}"); }
  const name = url.searchParams.get("name") ?? "";
  const rows = db.prepare("SELECT * FROM users WHERE name = ?").all(name);
  res.writeHead(200); res.end(JSON.stringify(rows));
});
server.listen(process.env.PORT || 3000);`;
const VULN_MIGRATION = "create table public.profiles (id uuid primary key, ssn text);";
const FIXED_MIGRATION = `create table public.profiles (id uuid primary key, ssn text);
alter table public.profiles enable row level security;
create policy "own_profile" on public.profiles for select using (auth.uid() = id);`;

function streamFor(files: Record<string, string>): string {
  const actions = Object.entries(files)
    .map(([path, content]) => `<boltAction type="file" filePath="${path}">${content}</boltAction>`)
    .join("");
  return `Here you go.<boltArtifact id="app" title="app">${actions}</boltArtifact>`;
}

const run = process.env.VIBEHARD_INTEGRATION ? describe : describe.skip;

run("escalation loop: generate → block → packet → fix → resume → deploy", () => {
  test("the full hand-off, end to end with real scanners", async () => {
    const dir = await workspace();

    // 1. Generate a vulnerable app through the engine seam.
    const session = await new BoltEngine(
      replayDriver([
        streamFor({
          "server.js": VULN_SERVER,
          "package.json": PKG,
          "supabase/migrations/0001_init.sql": VULN_MIGRATION,
        }),
      ]),
    ).startSession(dir, CONFIG);
    await drain(session.prompt("build a client portal"));

    // 2. Gate BLOCKS the deploy.
    const target = spyTarget();
    const blocked = await gatedDeploy(dir, target);
    expect(blocked.deployed).toBe(false);
    expect(target.calls).toBe(0);

    // 3. Build the routed, localized escalation packet from the block.
    const packet = await buildEscalationPacket(blocked.verdict.verdicts, dir);
    expect(packet.specialties).toEqual(expect.arrayContaining(["security", "database"]));
    expect(packet.items.some((i) => i.slice?.code.includes("STRIPE_SECRET_KEY"))).toBe(true);
    expect(packet.items.some((i) => i.specialty === "database")).toBe(true);

    // 4. Engineer fixes the flagged slices (secrets→env, parameterized query, RLS on).
    await Bun.write(join(dir, "server.js"), FIXED_SERVER);
    await Bun.write(join(dir, "supabase/migrations/0001_init.sql"), FIXED_MIGRATION);

    // 5. Resume: the GATE re-checks the fix (not the human's word) → deploys.
    const resumed = await resumeDeploy(dir, [], { target });
    expect(resumed.deployed).toBe(true);
    expect(resumed.escalation).toBeNull();
    expect(target.calls).toBe(1);
    expect(resumed.url).toBe("https://spy.example/app");
  }, 180_000);
});
