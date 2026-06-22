/**
 * The PRD stage (PROJECT_BRIEF.md §22) — stage 2 of the front-half: Spec → PRD.
 * The LLM elaborates the spec into requirements; this module derives the NFRs +
 * buy-vs-build deterministically and checks completeness before the architecture stage.
 */
export {
  assemblePrd,
  coerceRequirements,
  deriveNfrs,
  prdReviewVerdict,
  reviewPrd,
  type Prd,
  type Requirement,
} from "./prd.ts";
export { buyVsBuild, type BuyOrBuild, type BuyVsBuild } from "./buy-vs-build.ts";
export { elaboratePrd, type Elaborator, type ElaborateOptions, type ElaborateResult } from "./elaborate.ts";
export { llmElaborator, type LlmElaboratorOptions } from "./elaborate-llm.ts";
