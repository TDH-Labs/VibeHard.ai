import { describe, expect, test } from "bun:test";
import { coerceClassification, llmClassifier } from "./orchestrator-llm.ts";
import type { EngineConfig } from "../types.ts";

describe("llmClassifier — fails open on a broken model call (2026-07-09: closing the class of bug review.ts had)", () => {
  const config: EngineConfig = { provider: "opencode", model: "does-not-exist" };

  test("a modelFactory that throws → falls back to a friendly 'chat' reply, never crashes the orchestrator", async () => {
    const classifier = llmClassifier({
      config,
      modelFactory: () => {
        throw new Error("model factory blew up");
      },
    });
    const result = await classifier("what's going on with my build", "some context");
    expect(result).toEqual({ intent: "chat", arg: "I didn't catch that — say \"status\", \"why\", \"retry\", or \"help\"." });
  });
});

describe("coerceClassification (trust boundary)", () => {
  test("a valid intent passes through with its arg", () => {
    expect(coerceClassification({ intent: "set-model", arg: "codegen kimi" })).toEqual({ intent: "set-model", arg: "codegen kimi" });
  });
  test("an unknown/garbage intent falls back to chat", () => {
    expect(coerceClassification({ intent: "delete-everything" })).toEqual({ intent: "chat", arg: undefined });
    expect(coerceClassification("not an object")).toEqual({ intent: "chat", arg: undefined });
    expect(coerceClassification(null)).toEqual({ intent: "chat", arg: undefined });
  });
  test("ship is preserved (the orchestrator, not the classifier, gates the confirm)", () => {
    expect(coerceClassification({ intent: "ship" }).intent).toBe("ship");
  });
});
