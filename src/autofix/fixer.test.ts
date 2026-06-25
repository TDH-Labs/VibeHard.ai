import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { defaultFixer } from "./fixer.ts";
import { verdictOf, type GateVerdict } from "../types.ts";

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
/** A mock LLM that streams `text` as one bolt-protocol response. */
function mockModel(text: string): MockLanguageModelV3 {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: text },
    { type: "text-end", id: "1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
  return new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) }) });
}

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-fixer-"));
  tmps.push(d);
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x", dependencies: {} }));
  writeFileSync(join(d, "app", "page.tsx"), "export default function Page(){return null}");
  return d;
}
// A blocking code finding (sast) so the fixer's LLM pass runs.
function blockingVerdict(): GateVerdict {
  return verdictOf("sast", [{ tool: "sast", ruleId: "x", severity: "high", file: "app/page.tsx", message: "fix me" }], "2026-01-01T00:00:00Z");
}

describe("defaultFixer — no-op generation guard", () => {
  test("THROWS when the model emits no file actions (a 12-min empty pass must not read as success)", async () => {
    const fixer = defaultFixer({ modelFactory: () => mockModel("I considered the issue but here is only prose, no bolt actions.") });
    await expect(fixer(workspace(), [blockingVerdict()])).rejects.toThrow(/no file changes/);
  });

  test("builds ONE missing feature per round even when the gate reports many (tractable asks)", async () => {
    const bolt =
      '<boltArtifact id="f" title="f"><boltAction type="file" filePath="app/billing/page.tsx">export default function P(){return null}</boltAction></boltArtifact>';
    const model = mockModel(bolt);
    const features = ["billing and invoicing", "attendance check-in/out", "meal tracking"].map((feature) => ({
      tool: "completeness",
      ruleId: "feature-missing",
      severity: "high" as const,
      file: "app/",
      message: `The app is missing a feature the user explicitly asked for: "${feature}".`,
    }));
    const verdict = verdictOf("completeness", features, "2026-01-01T00:00:00Z");
    await defaultFixer({ modelFactory: () => model })(workspace(), [verdict]);
    // The model was asked to build exactly ONE of the three missing features this round.
    const sent = JSON.stringify(model.doStreamCalls[0]!.prompt);
    const asked = ["billing and invoicing", "attendance check-in/out", "meal tracking"].filter((f) => sent.includes(f));
    expect(asked).toHaveLength(1);
  });

  test("succeeds (no throw) when the model emits a bolt file action that materializes", async () => {
    const bolt =
      '<boltArtifact id="fix" title="fix">' +
      '<boltAction type="file" filePath="app/page.tsx">export default function Page(){return <div>fixed</div>}</boltAction>' +
      "</boltArtifact>";
    const dir = workspace();
    const fixer = defaultFixer({ modelFactory: () => mockModel(bolt) });
    await fixer(dir, [blockingVerdict()]);
    expect(readFileSync(join(dir, "app", "page.tsx"), "utf8")).toContain("fixed"); // the fix landed
  });
});
