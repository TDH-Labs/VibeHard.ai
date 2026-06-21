import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoltEngine, replayDriver, type BoltDriver } from "./engine.ts";
import type { EngineConfig, EngineEvent } from "../../types.ts";

const CONFIG: EngineConfig = { provider: "anthropic", model: "claude-opus-4-8" };
const tmps: string[] = [];

afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "drydock-bolt-"));
  tmps.push(d);
  return d;
}

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const STREAM =
  "Building it.\n" +
  '<boltArtifact id="x" title="x">' +
  '<boltAction type="file" filePath="src/app.ts">export const x = 1;</boltAction>' +
  '<boltAction type="file" filePath="README.md"># hi</boltAction>' +
  '<boltAction type="shell">bun install</boltAction>' +
  "</boltArtifact>";

describe("BoltEngine / BoltSession", () => {
  test("materializes files into our workspace and emits normalized events", async () => {
    const dir = await workspace();
    const engine = new BoltEngine(replayDriver([STREAM]));
    const session = await engine.startSession(dir, CONFIG);

    expect(session.workspacePath()).toBe(dir);
    const events = await collect(session.prompt("make an app"));

    expect(events).toEqual([
      { type: "thinking", text: "Generating your app…" },
      { type: "message", text: "Building it." },
      { type: "file-changed", path: "src/app.ts", action: "create" },
      { type: "file-changed", path: "README.md", action: "create" },
      { type: "message", text: "$ bun install" },
      { type: "done" },
    ]);

    // The files are really on disk — exactly what the gate chain will scan.
    expect(await Bun.file(join(dir, "src/app.ts")).text()).toBe("export const x = 1;");
    expect(await Bun.file(join(dir, "README.md")).text()).toBe("# hi");

    await session.dispose();
  });

  test("a driver failure surfaces as an error event, not a throw", async () => {
    const dir = await workspace();
    const boom: BoltDriver = {
      name: "boom",
      // eslint-disable-next-line require-yield
      async *run() {
        throw new Error("model unreachable");
      },
    };
    const session = await new BoltEngine(boom).startSession(dir, CONFIG);
    const events = await collect(session.prompt("go"));
    expect(events).toEqual([
      { type: "thinking", text: "Generating your app…" },
      { type: "error", message: "engine driver failed: model unreachable" },
    ]);
  });

  test("materializes files from EVERY artifact (multi-artifact, §14 Gap 2)", async () => {
    const dir = await workspace();
    const multi =
      '<boltArtifact id="a1" title="be"><boltAction type="file" filePath="server.js">A</boltAction></boltArtifact>' +
      '<boltArtifact id="a2" title="fe"><boltAction type="file" filePath="public/index.html">B</boltAction></boltArtifact>';
    const session = await new BoltEngine(replayDriver([multi])).startSession(dir, CONFIG);
    await collect(session.prompt("build"));

    // The old first-artifact-only parser would have dropped public/index.html.
    expect(await Bun.file(join(dir, "server.js")).text()).toBe("A");
    expect(await Bun.file(join(dir, "public/index.html")).text()).toBe("B");
  });

  test("materializes a supabase migration into supabase/migrations (RLS gate input)", async () => {
    const dir = await workspace();
    const stream =
      '<boltArtifact id="db" title="db">' +
      '<boltAction type="supabase" operation="migration" filePath="/supabase/migrations/init.sql">' +
      "create table public.profiles (id uuid primary key);" +
      "</boltAction></boltArtifact>";
    const session = await new BoltEngine(replayDriver([stream])).startSession(dir, CONFIG);
    const events = await collect(session.prompt("add a table"));

    // It lands as a real file at the path the RLS gate scans — not lost as a shell cmd.
    const sql = await Bun.file(join(dir, "supabase/migrations/init.sql")).text();
    expect(sql).toContain("create table public.profiles");
    expect(events).toContainEqual({ type: "file-changed", path: "/supabase/migrations/init.sql", action: "create" });
  });

  test("dispose forwards to the driver", async () => {
    const dir = await workspace();
    let disposed = false;
    const driver: BoltDriver = {
      name: "d",
      async *run() {
        yield "hi";
      },
      async dispose() {
        disposed = true;
      },
    };
    const session = await new BoltEngine(driver).startSession(dir, CONFIG);
    await session.dispose();
    expect(disposed).toBe(true);
  });
});
