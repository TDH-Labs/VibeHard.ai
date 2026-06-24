/**
 * The SRS stage — stage 3 of the front-half: PRD → SRS → (architecture). The LLM (a Principal
 * Systems Architect) specifies the software requirements; this module derives the operating
 * environment / security posture / compliance from the substrate and checks the SRS for
 * completeness + rigor (concrete metrics, strict I/O, flagged unknowns) before architecture.
 */
export {
  assembleSrs,
  coerceSrsDraft,
  deriveCompliance,
  deriveOperatingEnvironment,
  deriveSecurityPosture,
  emptySrsDraft,
  renderSrsMarkdown,
  reviewSrs,
  srsReviewVerdict,
  type ApiInterface,
  type Definition,
  type ErrorState,
  type FunctionalRequirement,
  type IoField,
  type OpenIssue,
  type OperatingEnvironment,
  type PerformanceTargets,
  type Reliability,
  type SchemaEntity,
  type SecurityPosture,
  type Srs,
  type SrsDraft,
} from "./srs.ts";
export { elaborateSrs, type Specifier, type SpecifyOptions, type SpecifyResult } from "./elaborate.ts";
export { llmSpecifier, type LlmSpecifierOptions } from "./elaborate-llm.ts";
