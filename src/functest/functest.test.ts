import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { coerceChecks, FunctionalReviewUnavailable, llmFunctionalReviewer, summarize } from "./functest.ts";

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
/** A mock model whose single generateText call returns `text` (non-streaming path). */
function genModel(text: string): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: async () => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: USAGE, warnings: [] }),
  });
}
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function appWith(code = "export default function Page(){return null}"): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-functest-"));
  tmps.push(d);
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app", "page.tsx"), code);
  return d;
}

describe("coerceChecks (trust boundary)", () => {
  test("parses valid checks, dedupes by feature, caps", () => {
    const out = coerceChecks({
      checks: [
        { feature: " Login ", status: "works", note: "auth wired" },
        { feature: "Login", status: "missing", note: "dup dropped" },
        { feature: "Save note", status: "partial", note: "no persistence" },
        { feature: "Search", status: "bogus", note: "invalid status → partial" },
        { feature: "", status: "works", note: "blank feature dropped" },
      ],
    });
    expect(out).toEqual([
      { feature: "Login", status: "works", note: "auth wired" },
      { feature: "Save note", status: "partial", note: "no persistence" },
      { feature: "Search", status: "partial", note: "invalid status → partial" },
    ]);
  });
  test("accepts a bare array; garbage → []", () => {
    expect(coerceChecks([{ feature: "X", status: "works", note: "" }])).toHaveLength(1);
    expect(coerceChecks("nope")).toEqual([]);
    expect(coerceChecks(null)).toEqual([]);
    expect(coerceChecks({ checks: "nope" })).toEqual([]);
  });
});

describe("llmFunctionalReviewer (the live reviewer's failure direction)", () => {
  test("returns checks when the model emits valid JSON", async () => {
    const json = JSON.stringify({ checks: [{ feature: "billing", status: "missing", note: "no page" }] });
    const reviewer = llmFunctionalReviewer({ modelFactory: () => genModel(json), config: { provider: "anthropic", model: "m" } });
    const checks = await reviewer(["billing"], appWith());
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("missing");
  });

  test("THROWS (never returns []) when the model yields no usable output over real sources — the false-pass guard", async () => {
    const reviewer = llmFunctionalReviewer({ modelFactory: () => genModel(""), config: { provider: "anthropic", model: "m" } });
    // empty text would coerce to [] → a caller could read that as "nothing missing" → false pass.
    await expect(reviewer(["billing", "attendance"], appWith())).rejects.toBeInstanceOf(FunctionalReviewUnavailable);
  });

  test("returns [] (legitimate N/A) when there are no features or no app code — not a failure", async () => {
    const reviewer = llmFunctionalReviewer({ modelFactory: () => genModel(""), config: { provider: "anthropic", model: "m" } });
    expect(await reviewer([], appWith())).toEqual([]); // no features
    const empty = mkdtempSync(join(tmpdir(), "vibehard-functest-empty-"));
    tmps.push(empty);
    expect(await reviewer(["billing"], empty)).toEqual([]); // no sources
  });
});

describe("summarize", () => {
  test("counts by status", () => {
    expect(
      summarize([
        { feature: "a", status: "works", note: "" },
        { feature: "b", status: "works", note: "" },
        { feature: "c", status: "partial", note: "" },
        { feature: "d", status: "missing", note: "" },
      ]),
    ).toEqual({ works: 2, partial: 1, missing: 1, total: 4 });
  });
});
