/**
 * Adversarial front-half review — the front-half's missing adversary. Deterministic
 * cross-consistency checks (block) + an LLM red-team (advisory → human). The judgment
 * layer for spec/PRD/architecture, where code gates can't reach.
 */
export { crossCheck } from "./crosscheck.ts";
export { reviewFrontHalf, type Adversary, type FrontHalfBundle, type FrontHalfReview } from "./review.ts";
export { llmAdversary, coerceAdversarialFindings, type LlmAdversaryOptions } from "./adversary-llm.ts";
