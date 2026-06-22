/**
 * The architecture stage (PROJECT_BRIEF.md §22) — stage 3 of the front-half:
 * PRD → a stack + workstream dependency graph the codegen builds from, tier by tier.
 */
export {
  architectureVerdict,
  buildOrder,
  coerceArchitecture,
  reviewArchitecture,
  type Architecture,
  type Workstream,
} from "./architecture.ts";
export { architectApp, type Architect, type ArchitectOptions, type ArchitectResult } from "./architect.ts";
export { llmArchitect, type LlmArchitectOptions } from "./architect-llm.ts";
