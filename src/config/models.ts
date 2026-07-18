/**
 * Per-stage model assignment (right-fit, not one-size). VibeHard used to run EVERY stage on a single
 * `VIBEHARD_MODEL` — so setting it to a fast/cheap model silently ran CODEGEN and AUTO-FIX on it too,
 * which is the worst place to economize (it's where buggy apps come from). Instead, each pipeline
 * stage maps to a capability TIER, and the tier maps to a concrete model for the active provider:
 *
 *   • code       — codegen + auto-fix (highest stakes, code-heavy)         → the strongest CODE model
 *   • reason     — architecture (SAD) + adversarial review                 → the strongest REASONING
 *                  (mistakes here cascade into every downstream workstream, or defeat the one
 *                  check designed to catch a bad plan before it's built — never economize here)
 *   • reason-lite — intake, spec, PRD, SRS, refactor, polish               → a cheaper reasoning
 *                  model (2026-07-09: split out of `reason` — these stages are either bounded/
 *                  fail-safe by design (intake caps at 7 questions and degrades to "done" on any
 *                  error) or self-correcting (refactor/polish revert themselves if they regress a
 *                  passing build), so a materially cheaper model is a reasonable trade here even
 *                  before it's been A/B'd against `reason` on real output)
 *   • light      — advisory (functest, procurement narration)              → a fast, cheap model
 *
 * Resolution per stage: VIBEHARD_MODEL_<STAGE> (explicit override) → VIBEHARD_MODEL (global "one
 * model everywhere" escape hatch) → the right-fit tier default. So a stage is always visible and
 * overridable, and there's no silent "everything ran on the cheap model" trap.
 *
 * Cloud-only, deliberately: this file has no "local"/"ollama" provider and shouldn't grow one. A
 * self-hosted model on someone's laptop can't back a live multi-tenant SaaS build — it'd tie the
 * product's uptime to that machine being on and reachable. Local models have a real role in
 * offline dev-time testing (the eval harness, run on a developer's own machine); they don't belong
 * in this file, which is what a LIVE build actually calls.
 */
export type Stage = "intake" | "spec" | "prd" | "srs" | "sad" | "review" | "codegen" | "fix" | "refactor" | "polish" | "functest" | "procurement";
type Tier = "code" | "reason" | "reason-lite" | "light";

const TIER: Record<Stage, Tier> = {
  intake: "reason-lite",
  spec: "reason-lite",
  prd: "reason-lite",
  srs: "reason-lite",
  sad: "reason",
  review: "reason",
  codegen: "code",
  fix: "code",
  refactor: "reason-lite",
  polish: "reason-lite",
  functest: "light",
  procurement: "light",
};

// Right-fit model per tier, per provider (OpenRouter / OpenCode Zen / Anthropic). The openrouter
// tierset is the SAME model families as opencode's, just under OpenRouter's vendor-prefixed slugs
// (verified against the live /api/v1/models catalog 2026-07-01) — switching gateways ≠ switching models.
// `reason-lite` prices ~2x-2.7x cheaper than `reason` on OpenRouter's live catalog (checked
// 2026-07-09: deepseek-v4-pro $0.435/$0.87 per M tokens vs deepseek-v3.2 $0.2145/$0.32175) while
// staying in the SAME model family as `reason`, not a cross-vendor jump — the safer first move
// pending a real quality A/B (see docs/ROADMAP.md).
const MODELS: Record<string, Record<Tier, string>> = {
  openrouter: { code: "moonshotai/kimi-k2.7-code", reason: "deepseek/deepseek-v4-pro", "reason-lite": "deepseek/deepseek-v3.2", light: "deepseek/deepseek-v4-flash" },
  // reason-lite moved to deepseek-v4-flash 2026-07-17: OpenCode Zen DELISTED deepseek-v3.2 (checked
  // the live /zen/go/v1/models catalog directly — v3.2 is gone; v4-pro / v4-flash / kimi-k2.7-code
  // remain) and a live build failed at the very first stage with "Model deepseek-v3.2 is not
  // supported". Flash is the remaining cheaper member of the SAME family — the tier's original
  // rationale (bounded/fail-safe stages tolerate a cheaper model) unchanged.
  opencode: { code: "kimi-k2.7-code", reason: "deepseek-v4-pro", "reason-lite": "deepseek-v4-flash", light: "deepseek-v4-flash" },
  anthropic: { code: "claude-opus-4-8", reason: "claude-opus-4-8", "reason-lite": "claude-sonnet-5", light: "claude-haiku-4-5" },
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
