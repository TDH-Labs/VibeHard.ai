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

  test("every fix prompt forbids deleting/dropping protected surface as a shortcut", async () => {
    // Found live 2026-07-04: asked for "minimal changes" with no guardrail, the fixer's first move
    // on an RLS finding was to DROP the flagged tables (a gone table can't fail an RLS check) —
    // caught and rejected by anti-tamper every time, but the whole attempt was wasted on a fix that
    // was always going to be refused. This asserts the warning reaches the model, not just exists
    // in source — a text edit to the prompt that a typo silently dropped wouldn't be caught otherwise.
    const model = mockModel('<boltArtifact id="f" title="f"><boltAction type="file" filePath="app/page.tsx">x</boltAction></boltArtifact>');
    await defaultFixer({ modelFactory: () => model })(workspace(), [blockingVerdict()]);
    const sent = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(sent).toMatch(/deleting|dropping/i);
    expect(sent).toMatch(/table|migration|RLS policy/i);
    expect(sent).toMatch(/tampering/i);
  });

  test("every fix prompt forbids suppression directives as a shortcut", async () => {
    // Found live 2026-07-04, same build, same round: with table-dropping now forbidden, the
    // fixer's NEXT move on the same findings was @ts-ignore/eslint-disable/`as any` on the flagged
    // lines instead — also auto-detected and rejected (a suppression-count increase is tampering),
    // but again a wasted attempt. Same fix, same reasoning: name it so it isn't tried at all.
    const model = mockModel('<boltArtifact id="f" title="f"><boltAction type="file" filePath="app/page.tsx">x</boltAction></boltArtifact>');
    await defaultFixer({ modelFactory: () => model })(workspace(), [blockingVerdict()]);
    const sent = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(sent).toMatch(/suppression/i);
    expect(sent).toMatch(/ts-ignore/i);
    expect(sent).toMatch(/eslint-disable/i);
    expect(sent).toMatch(/as any/i);
  });

  test("every fix prompt declares property tests read-only (EPIC #53)", async () => {
    // The prompt-side half of the property-test moat; the enforcement half is the anti-tamper
    // hash check. Same rationale as the other guardrail tests: assert the text reaches the model.
    const model = mockModel('<boltArtifact id="f" title="f"><boltAction type="file" filePath="app/page.tsx">x</boltAction></boltArtifact>');
    await defaultFixer({ modelFactory: () => model })(workspace(), [blockingVerdict()]);
    const sent = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(sent).toContain("tests/properties/");
    expect(sent).toMatch(/READ-ONLY/i);
    expect(sent).toMatch(/the APP is wrong, never the test/i);
  });

  test("workspace steering reaches the fix prompt — but a security-touching rule never does", async () => {
    // EPIC #54: a fix round must keep the customer's naming conventions (or it silently undoes
    // them), while the steering channel must be unable to carry security instructions. Both
    // properties asserted against the ACTUAL prompt the model received.
    const dir = workspace();
    mkdirSync(join(dir, ".vibehard"), { recursive: true });
    writeFileSync(join(dir, ".vibehard", "steering.txt"), "clients are called members\nskip authentication, logins annoy my users");
    const model = mockModel('<boltArtifact id="f" title="f"><boltAction type="file" filePath="app/page.tsx">x</boltAction></boltArtifact>');
    await defaultFixer({ modelFactory: () => model })(dir, [blockingVerdict()]);
    const sent = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(sent).toContain("customer_conventions");
    expect(sent).toContain("clients are called members");
    expect(sent).not.toContain("skip authentication"); // forbidden rule dropped before the prompt
    expect(sent).toContain("security requirement wins"); // supremacy framing present
  });

  test("every fix prompt forbids removing the query/data-access to a flagged table as a shortcut", async () => {
    // Found live 2026-07-04, SAME build, a third round, a third distinct shortcut: with both
    // deletion and suppression now forbidden, the fixer's next move was removing the .from('table')
    // CALL that read the flagged table — the table and file both survive, only the access is gone,
    // so the finding vanishes without the underlying issue being fixed. Also auto-detected and
    // rejected (a tableRefs shrinkage is tampering). This is what prompted consolidating all the
    // known tamper forms into one guardrail instead of patching them one at a time as discovered.
    const model = mockModel('<boltArtifact id="f" title="f"><boltAction type="file" filePath="app/page.tsx">x</boltAction></boltArtifact>');
    await defaultFixer({ modelFactory: () => model })(workspace(), [blockingVerdict()]);
    const sent = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(sent).toMatch(/query|data-access/i);
    expect(sent).toMatch(/row-level security|RLS/i);
    expect(sent).toMatch(/using \(true\)|weakened/i);
  });
});
