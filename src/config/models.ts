/**
 * Per-stage model assignment (right-fit, not one-size). VibeHard used to run EVERY stage on a single
 * `VIBEHARD_MODEL` — so setting it to a fast/cheap model silently ran CODEGEN and AUTO-FIX on it too,
 * which is the worst place to economize (it's where buggy apps come from). Instead, each pipeline
 * stage maps to a capability TIER, and the tier maps to a concrete model for the active provider:
 *
 *   • code    — codegen + auto-fix (highest stakes, code-heavy)        → the strongest CODE model
 *   • reason  — intake, spec, PRD, SRS, SAD, review, refactor, polish  → a solid reasoning model
 *   • light   — advisory (functest, procurement narration)            → a fast, cheap model
 *
 * Resolution per stage: VIBEHARD_MODEL_<STAGE> (explicit override) → VIBEHARD_MODEL (global "one
 * model everywhere" escape hatch) → the right-fit tier default. So a stage is always visible and
 * overridable, and there's no silent "everything ran on the cheap model" trap.
 */
export type Stage = "intake" | "spec" | "prd" | "srs" | "sad" | "review" | "codegen" | "fix" | "refactor" | "polish" | "functest" | "procurement";
type Tier = "code" | "reason" | "light";

const TIER: Record<Stage, Tier> = {
  intake: "reason",
  spec: "reason",
  prd: "reason",
  srs: "reason",
  sad: "reason",
  review: "reason",
  codegen: "code",
  fix: "code",
  refactor: "reason",
  polish: "reason",
  functest: "light",
  procurement: "light",
};

// Right-fit model per tier, per provider (OpenRouter / OpenCode Zen / Anthropic). The openrouter
// tierset is the SAME model families as opencode's, just under OpenRouter's vendor-prefixed slugs
// (verified against the live /api/v1/models catalog 2026-07-01) — switching gateways ≠ switching models.
const MODELS: Record<string, Record<Tier, string>> = {
  openrouter: { code: "moonshotai/kimi-k2.7-code", reason: "deepseek/deepseek-v4-pro", light: "deepseek/deepseek-v4-flash" },
  opencode: { code: "kimi-k2.7-code", reason: "deepseek-v4-pro", light: "deepseek-v4-flash" },
  anthropic: { code: "claude-opus-4-8", reason: "claude-opus-4-8", light: "claude-haiku-4-5" },
};

export function providerOf(): string {
  return (
    process.env.VIBEHARD_PROVIDER ||
    (process.env.OPENROUTER_API_KEY ? "openrouter" : process.env.OPENCODE_API_KEY ? "opencode" : "anthropic")
  );
}

/** The model for a pipeline stage (override-aware, right-fit default). */
export function modelForStage(stage: Stage): string {
  const override = process.env[`VIBEHARD_MODEL_${stage.toUpperCase()}`];
  if (override) return override;
  const global = process.env.VIBEHARD_MODEL; // optional "one model everywhere" escape hatch
  if (global) return global;
  const provider = providerOf();
  return (MODELS[provider] ?? MODELS.opencode!)[TIER[stage]];
}

/** The provider + model for a stage, ready to pass as an EngineConfig. */
export function configForStage(stage: Stage): { provider: string; model: string } {
  return { provider: providerOf(), model: modelForStage(stage) };
}

/** The full plan — for showing the operator which model runs at each stage (visibility). */
export function modelPlan(): Array<{ stage: Stage; model: string }> {
  return (Object.keys(TIER) as Stage[]).map((stage) => ({ stage, model: modelForStage(stage) }));
}
