import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configForStage, modelForStage, modelPlan, providerOf, type Stage } from "./models.ts";

const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "VIBEHARD_PROVIDER", "VIBEHARD_MODEL"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const k of Object.keys(process.env)) if (k.startsWith("VIBEHARD_MODEL_")) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) if (saved[k] !== undefined) process.env[k] = saved[k]!; else delete process.env[k];
});

describe("stage → tier assignment (cloud-only, right-fit)", () => {
  test("SAD + review stay on the strongest reasoning model — mistakes here cascade or defeat the plan's own safety net", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    expect(modelForStage("sad")).toBe("deepseek/deepseek-v4-pro");
    expect(modelForStage("review")).toBe("deepseek/deepseek-v4-pro");
  });

  test("bounded/self-correcting planning stages run on the cheaper reason-lite tier", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    const liteStages: Stage[] = ["intake", "spec", "prd", "srs", "refactor", "polish"];
    for (const s of liteStages) expect(modelForStage(s)).toBe("deepseek/deepseek-v3.2");
  });

  test("codegen + fix stay on the code-specialized model regardless of the reasoning tier split", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    expect(modelForStage("codegen")).toBe("moonshotai/kimi-k2.7-code");
    expect(modelForStage("fix")).toBe("moonshotai/kimi-k2.7-code");
  });

  test("advisory stages stay on the light tier", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    expect(modelForStage("functest")).toBe("deepseek/deepseek-v4-flash");
    expect(modelForStage("procurement")).toBe("deepseek/deepseek-v4-flash");
  });

  test("every stage resolves to SOME model for every provider — no gap in the tier table", () => {
    const stages: Stage[] = ["intake", "spec", "prd", "srs", "sad", "review", "codegen", "fix", "refactor", "polish", "functest", "procurement"];
    for (const provider of ["openrouter", "opencode", "anthropic"]) {
      process.env.VIBEHARD_PROVIDER = provider;
      for (const s of stages) expect(typeof modelForStage(s)).toBe("string");
    }
  });

  test("per-stage override still wins over the tier default", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    process.env.VIBEHARD_MODEL_SAD = "some/other-model";
    expect(modelForStage("sad")).toBe("some/other-model");
  });

  test("global VIBEHARD_MODEL escape hatch still overrides every stage", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    process.env.VIBEHARD_MODEL = "everything/one-model";
    expect(modelForStage("sad")).toBe("everything/one-model");
    expect(modelForStage("intake")).toBe("everything/one-model");
  });

  test("configForStage pairs the provider with the resolved model", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    expect(configForStage("sad")).toEqual({ provider: "openrouter", model: "deepseek/deepseek-v4-pro" });
  });

  test("modelPlan lists all 12 stages", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-x";
    expect(modelPlan()).toHaveLength(12);
  });

  test("providerOf resolves openrouter → opencode → anthropic by key presence", () => {
    expect(providerOf()).toBe("anthropic");
    process.env.OPENCODE_API_KEY = "x";
    expect(providerOf()).toBe("opencode");
    process.env.OPENROUTER_API_KEY = "x";
    expect(providerOf()).toBe("openrouter");
  });
});
