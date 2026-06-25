import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream, type LanguageModel } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { defaultModelFactory, liveBoltDriver } from "./driver.ts";
import { BoltEngine } from "./engine.ts";
import { VIBEHARD_SYSTEM_PROMPT } from "./prompt.ts";
import type { EngineConfig, EngineEvent } from "../../types.ts";

const CONFIG: EngineConfig = { provider: "anthropic", model: "claude-opus-4-8" };

// Minimal valid v3 usage (all fields optional-number; the gate doesn't read these).
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** A mock LLM that streams `textChunks` as a valid v3 text stream. */
function mockModel(textChunks: string[]): MockLanguageModelV3 {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "1" },
    ...textChunks.map((delta): LanguageModelV3StreamPart => ({ type: "text-delta", id: "1", delta })),
    { type: "text-end", id: "1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) }),
  });
}

async function collectText(driver: { run: (p: string, c: EngineConfig) => AsyncIterable<string> }): Promise<string> {
  let out = "";
  for await (const chunk of driver.run("build a users api", CONFIG)) out += chunk;
  return out;
}

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("liveBoltDriver", () => {
  const ARTIFACT =
    'Plan: a tiny server.<boltArtifact id="x" title="x">' +
    '<boltAction type="file" filePath="server.js">console.log(1)</boltAction>' +
    "</boltArtifact>";

  test("streams the model's bolt-protocol text out verbatim", async () => {
    // split across deltas to prove chunk reassembly
    const model = mockModel([ARTIFACT.slice(0, 20), ARTIFACT.slice(20)]);
    const driver = liveBoltDriver({ modelFactory: () => model });
    expect(await collectText(driver)).toBe(ARTIFACT);
  });

  test("sends our system prompt and the user prompt to the model", async () => {
    const model = mockModel(["hi"]);
    const driver = liveBoltDriver({ modelFactory: () => model });
    await collectText(driver);

    expect(model.doStreamCalls).toHaveLength(1);
    const sent = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(sent).toContain("You are VibeHard"); // our derived system prompt
    expect(sent).toContain("<boltArtifact>"); // protocol rules carried in the prompt
    expect(sent).toContain("build a users api"); // the user's prompt
  });

  test("retries a TRANSIENT stream failure, then yields the full result (no infinite hang)", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        if (calls === 1) throw new Error("fetch failed"); // a dead/stalled stream on the first attempt
        const chunks: LanguageModelV3StreamPart[] = [
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: ARTIFACT },
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
        ];
        return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
      },
    });
    const driver = liveBoltDriver({ modelFactory: () => model });
    expect(await collectText(driver)).toBe(ARTIFACT); // recovered: full artifact, materialization safe
    expect(calls).toBe(2); // failed once, retried from scratch, succeeded
  });

  test("does NOT retry a non-transient failure (e.g. bad credentials) — fails fast", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        throw new Error("invalid x-api-key");
      },
    });
    const driver = liveBoltDriver({ modelFactory: () => model });
    await expect(collectText(driver)).rejects.toThrow(/invalid x-api-key/);
    expect(calls).toBe(1); // not transient → no wasted retries
  });

  test("the model factory receives the EngineConfig (provider routing stays ours)", async () => {
    const calls: EngineConfig[] = [];
    const factory = (c: EngineConfig): LanguageModel => {
      calls.push(c);
      return mockModel(["x"]);
    };
    await collectText(liveBoltDriver({ modelFactory: factory }));
    expect(calls).toEqual([CONFIG]);
  });
});

describe("defaultModelFactory", () => {
  test("rejects an unsupported provider with an actionable message", () => {
    expect(() => defaultModelFactory({ provider: "openai", model: "gpt-x" })).toThrow(/unsupported engine provider 'openai'/);
  });

  test("requires ANTHROPIC_API_KEY for the anthropic provider", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => defaultModelFactory(CONFIG)).toThrow(/ANTHROPIC_API_KEY is not set/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test("routes the opencode provider when OPENCODE_API_KEY is set (no network)", () => {
    const saved = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "test-key";
    try {
      // createOpenAICompatible builds the model lazily — construction makes no request.
      expect(defaultModelFactory({ provider: "opencode", model: "deepseek-v4-pro" })).toBeTruthy();
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = saved;
    }
  });

  test("requires OPENCODE_API_KEY for the opencode provider", () => {
    const saved = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    try {
      expect(() => defaultModelFactory({ provider: "opencode", model: "deepseek-v4-pro" })).toThrow(/OPENCODE_API_KEY is not set/);
    } finally {
      if (saved !== undefined) process.env.OPENCODE_API_KEY = saved;
    }
  });
});

describe("BoltEngine + liveBoltDriver (mocked LLM)", () => {
  test("a mocked generation materializes files into the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibehard-driver-"));
    tmps.push(dir);
    const stream =
      'Building.<boltArtifact id="a" title="a">' +
      '<boltAction type="file" filePath="server.js">export const ok = true;</boltAction>' +
      "</boltArtifact>";
    const driver = liveBoltDriver({ modelFactory: () => mockModel([stream]) });
    const session = await new BoltEngine(driver).startSession(dir, CONFIG);

    const events: EngineEvent[] = [];
    for await (const e of session.prompt("make it")) events.push(e);

    expect(await Bun.file(join(dir, "server.js")).text()).toBe("export const ok = true;");
    expect(events).toContainEqual({ type: "file-changed", path: "server.js", action: "create" });
  });
});

// VIBEHARD_SYSTEM_PROMPT is exercised above; keep a direct guard on its key invariants.
describe("VIBEHARD_SYSTEM_PROMPT", () => {
  test("carries the protocol + the baked gate standards", () => {
    expect(VIBEHARD_SYSTEM_PROMPT).toContain("<boltArtifact>");
    expect(VIBEHARD_SYSTEM_PROMPT).toContain("parameterized");
    expect(VIBEHARD_SYSTEM_PROMPT).toContain("enable row level security");
    expect(VIBEHARD_SYSTEM_PROMPT).toContain("environment variables");
    expect(VIBEHARD_SYSTEM_PROMPT).not.toContain("WebContainer"); // browser-runtime constraints stripped
  });
});
