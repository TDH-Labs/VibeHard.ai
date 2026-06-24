/**
 * Front-half (PROJECT_BRIEF.md §22, §15): intake → PRD → architecture, the
 * "scoped + architected" half that runs BEFORE codegen. This increment ships the
 * deterministic keystone — the PRD artifact + the spec-readiness check + the
 * adaptive-rigor decision. The LLM intake that drafts a PRD is the proposing seam.
 */
export {
  decideRigor,
  isSensitive,
  specVerdict,
  reviewSpec,
  type DataEntity,
  type Spec,
  type Rigor,
  type SensitiveClass,
  type Tenancy,
} from "./spec.ts";
export { coerceSpec, extractJsonObject, parseSpec, tryExtractJsonObject } from "./coerce.ts";
export { planIntake, type Intake, type PlanOptions, type PlanResult } from "./intake.ts";
export { llmIntake, type LlmIntakeOptions } from "./intake-llm.ts";
export { coerceAssumptions, foldAssumptions, llmAssumptionProposer, type AssumptionProposer, type AssumptionProposerOptions, type ConfirmedAssumption } from "./assumptions.ts";
export { buildGenerationBrief, securityRequirements } from "./brief.ts";
