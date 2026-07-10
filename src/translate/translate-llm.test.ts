import { describe, expect, test } from "bun:test";
import { llmTranslator } from "./translate-llm.ts";
import type { EngineConfig } from "../types.ts";
import type { Finding } from "../types.ts";

const finding: Finding = { tool: "sast", ruleId: "sql-injection", severity: "high", file: "app/api/route.ts", message: "raw string concatenation into a SQL query" };

describe("llmTranslator — fails open on a broken model call (2026-07-09: closing the class of bug review.ts had)", () => {
  const config: EngineConfig = { provider: "opencode", model: "does-not-exist" };

  test("a modelFactory that throws → falls back to the honest generic explanation, never crashes", async () => {
    const translator = llmTranslator({
      config,
      modelFactory: () => {
        throw new Error("model factory blew up");
      },
    });
    const result = await translator(finding);
    expect(result.source).toBe("generic");
    expect(result.ruleId).toBe("sql-injection");
    expect(result.detail).toContain("sast");
    expect(result.detail).toContain("high");
  });
});
