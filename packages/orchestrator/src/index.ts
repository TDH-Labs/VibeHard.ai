/**
 * A conversational build assistant — routes free-form messages to deterministic actions
 * (via an injected `BuildTools`), gates consequential ones behind an explicit human confirm.
 * See `orchestrator.ts` for the full design rationale.
 */
export {
  Orchestrator,
  routeKeyword,
  proactiveMessage,
  type OutboundKind,
  type OutboundMessage,
  type Channel,
  type BuildEvent,
  type BuildTools,
  type Intent,
  type Classification,
  type Classifier,
} from "./orchestrator.ts";

export { llmClassifier, coerceClassification, type LlmConfig, type ModelFactory } from "./orchestrator-llm.ts";
