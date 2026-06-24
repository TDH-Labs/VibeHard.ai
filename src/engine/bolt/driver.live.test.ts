/**
 * Live driver smoke test — real Anthropic call through the AI SDK. Guarded behind
 * ANTHROPIC_API_KEY (it costs money and needs network), so it's skipped by default
 * and in CI without a key. Run with:
 *
 *   ANTHROPIC_API_KEY=sk-... bun test driver.live
 *
 * Proves the whole seam is live end to end: real model → bolt protocol →
 * normalizer → file materialization in our workspace.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoltEngine } from "./engine.ts";
import { liveBoltDriver } from "./driver.ts";
import type { EngineConfig, EngineEvent } from "../../types.ts";

const CONFIG: EngineConfig = { provider: "anthropic", model: "claude-opus-4-8" };
const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});

const run = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

run("liveBoltDriver (real Anthropic)", () => {
  test("generates a real app that materializes files into the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibehard-live-"));
    tmps.push(dir);
    const session = await new BoltEngine(liveBoltDriver()).startSession(dir, CONFIG);

    const events: EngineEvent[] = [];
    for await (const ev of session.prompt("Create a single-file Node.js HTTP server with a /health endpoint that returns 200 JSON.")) {
      events.push(ev);
    }
    await session.dispose();

    expect(events.some((e) => e.type === "file-changed")).toBe(true);
    const files = await readdir(dir);
    expect(files.length).toBeGreaterThan(0);
  }, 180_000);
});
