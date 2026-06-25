import { describe, expect, test } from "bun:test";
import { coerceClassification } from "./orchestrator-llm.ts";

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
