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
  const d = await mkdtemp(join(tmpdir(), "vibehard-bolt-"));
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

import { containedPath } from "./engine.ts";
import { existsSync } from "node:fs";

describe("hallucinated-lockfile guard (2026-07-09 — real dogfooding EINTEGRITY root cause)", () => {
  test("a model-authored package-lock.json is skipped, not written — legit files still land", async () => {
    const dir = await workspace();
    const stream =
      '<boltArtifact id="x" title="x">' +
      '<boltAction type="file" filePath="package-lock.json">{"lockfileVersion": 3}</boltAction>' +
      '<boltAction type="file" filePath="src/app.ts">export const x = 1;</boltAction>' +
      "</boltArtifact>";
    const session = await new BoltEngine(replayDriver([stream])).startSession(dir, CONFIG);
    const events = await collect(session.prompt("make an app"));

    expect(existsSync(join(dir, "package-lock.json"))).toBe(false);
    expect(await Bun.file(join(dir, "src/app.ts")).text()).toBe("export const x = 1;");
    expect(events).toContainEqual({
      type: "message",
      text: "skipped a model-authored lockfile (package-lock.json) — the real one is generated by npm/bun install",
    });
    expect(events.some((e) => e.type === "file-changed" && e.path === "package-lock.json")).toBe(false);
  });

  test("every known lockfile basename is refused, including a nested one and a root-relative filePath", async () => {
    const dir = await workspace();
    const names = ["yarn.lock", "bun.lock", "bun.lockb", "npm-shrinkwrap.json", "pnpm-lock.yaml", "sub/dir/bun.lock", "/package-lock.json"];
    const actions = names.map((n) => `<boltAction type="file" filePath="${n}">bogus</boltAction>`).join("");
    const session = await new BoltEngine(replayDriver([`<boltArtifact id="x" title="x">${actions}</boltArtifact>`])).startSession(dir, CONFIG);
    await collect(session.prompt("go"));

    for (const n of names) {
      expect(existsSync(join(dir, n.replace(/^\//, "")))).toBe(false);
    }
  });

  test("a file that merely CONTAINS a lockfile name as a substring is NOT caught (basename match only)", async () => {
    const dir = await workspace();
    const stream = '<boltArtifact id="x" title="x"><boltAction type="file" filePath="scripts/regen-package-lock.json.sh">#!/bin/sh</boltAction></boltArtifact>';
    const session = await new BoltEngine(replayDriver([stream])).startSession(dir, CONFIG);
    await collect(session.prompt("go"));
    expect(existsSync(join(dir, "scripts/regen-package-lock.json.sh"))).toBe(true);
  });
});

describe("C3 — path-traversal containment (LLM controls filePath)", () => {
  test("containedPath: normal + root-relative paths resolve INSIDE; traversal/escape → null", () => {
    const root = "/tmp/ws";
    expect(containedPath(root, "src/app.ts")).toBe("/tmp/ws/src/app.ts");
    expect(containedPath(root, "/supabase/migrations/init.sql")).toBe("/tmp/ws/supabase/migrations/init.sql"); // leading "/" = root
    expect(containedPath(root, "a/../b.ts")).toBe("/tmp/ws/b.ts"); // stays inside → fine
    expect(containedPath(root, "../../etc/cron.d/x")).toBeNull(); // escapes the workspace
    expect(containedPath(root, "../sibling")).toBeNull();
  });

  test("the engine REFUSES a traversal filePath: error event, nothing written outside the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibehard-trav-"));
    try {
      const evil = '<boltArtifact id="e" title="e"><boltAction type="file" filePath="../../escaped.txt">pwned</boltAction><boltAction type="file" filePath="ok.txt">fine</boltAction></boltArtifact>';
      const session = await new BoltEngine(replayDriver([evil])).startSession(dir, CONFIG);
      const events: EngineEvent[] = [];
      for await (const e of session.prompt("go")) events.push(e);
      expect(events.some((e) => e.type === "error" && /outside the workspace/.test((e as { message: string }).message))).toBe(true);
      expect(existsSync(join(dir, "..", "escaped.txt"))).toBe(false); // the escape never landed
      expect(existsSync(join(dir, "ok.txt"))).toBe(true); // the legit file still wrote
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
