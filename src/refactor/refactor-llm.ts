/**
 * The live skill half of refactor-phase (PROJECT_BRIEF.md §22): an LLM scores code
 * QUALITY into a brief, and an LLM applies behavior-preserving changes. The
 * deterministic re-verify (in refactor.ts's loop) decides whether the change
 * survives — these only propose. Reuses the engine ModelFactory + the bolt engine
 * (like the auto-fixer), so provider/model selection stays single-sourced.
 */
import { generateText } from "ai";
import { tryExtractJsonObject } from "../spec/index.ts";
import { readAppSources } from "../gate/rls.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import { BoltEngine } from "../engine/bolt/engine.ts";
import { liveBoltDriver } from "../engine/bolt/driver.ts";
import { coerceRefactorBrief, type RefactorBrief, type Refactorer, type Scorer } from "./refactor.ts";

const SCORE_SYSTEM_PROMPT = `You review code QUALITY — NOT correctness (the app already works and passes its checks). Find concrete, high-value maintainability issues: duplication, over-long functions doing several things, tight coupling to I/O, weak error handling, hard-to-test structure, missing edge-case handling.

Return ONLY a JSON object (no prose, no fence): {"summary": string, "targets": [{"file": string, "issue": string}]}.
- List only improvements that are clearly worth it AND behavior-preserving.
- If the code is already clean, return an empty "targets" array.`;

const SOURCE_CAP = 60_000;

function sourceBlock(sources: Array<{ file: string; code: string }>): string {
  const out: string[] = [];
  let total = 0;
  for (const { file, code } of sources) {
    if (total >= SOURCE_CAP) break;
    total += code.length;
    out.push(`--- ${file} ---\n${code}`);
  }
  return out.join("\n\n");
}

export interface RefactorLlmOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

function resolveConfig(opts: RefactorLlmOptions): EngineConfig {
  return (
    opts.config ??
    (process.env.OPENCODE_API_KEY ? { provider: "opencode", model: "deepseek-v4-pro" } : { provider: "anthropic", model: "claude-opus-4-8" })
  );
}

export function llmScorer(opts: RefactorLlmOptions = {}): Scorer {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config = resolveConfig(opts);
  return async (workspace) => {
    const sources = await readAppSources(workspace);
    if (sources.length === 0) return { targets: [], summary: "no source to review" };
    const { text } = await generateText({
      model: modelFactory(config),
      system: SCORE_SYSTEM_PROMPT,
      prompt: `Project files:\n\n${sourceBlock(sources)}`,
      maxOutputTokens: 4000,
    });
    return coerceRefactorBrief(tryExtractJsonObject(text));
  };
}

function refactorPrompt(brief: RefactorBrief, sources: Array<{ file: string; code: string }>): string {
  return [
    "Refactor the code ONLY for the quality targets below. This MUST be behavior-preserving:",
    "do NOT change features, the public API/routes, configuration, the data model, or dependencies —",
    "only restructure for clarity/maintainability. Output the corrected files as bolt file actions.",
    "",
    "Targets:",
    ...brief.targets.map((t) => `- ${t.file}: ${t.issue}`),
    "",
    "Current project files:",
    "",
    sourceBlock(sources),
  ].join("\n");
}

export function llmRefactorer(opts: RefactorLlmOptions = {}): Refactorer {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config = resolveConfig(opts);
  return async (workspace, brief) => {
    const sources = await readAppSources(workspace);
    const session = await new BoltEngine(liveBoltDriver({ modelFactory })).startSession(workspace, config);
    try {
      for await (const _ of session.prompt(refactorPrompt(brief, sources))) void _;
    } finally {
      await session.dispose();
    }
  };
}
