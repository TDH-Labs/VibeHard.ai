/**
 * refactor-phase (PROJECT_BRIEF.md §22, maintainability tier): after the app passes,
 * improve quality without changing behavior — score → refactor → re-verify, revert on
 * break ("the passing build is sacred"). Skill proposes, deterministic disposes.
 */
export {
  coerceRefactorBrief,
  fileCheckpointer,
  refactorPhase,
  type Checkpointer,
  type RefactorBrief,
  type RefactorOptions,
  type RefactorResult,
  type RefactorTarget,
  type Refactorer,
  type Scorer,
  type Verifier,
} from "./refactor.ts";
export { llmScorer, llmRefactorer, type RefactorLlmOptions } from "./refactor-llm.ts";
