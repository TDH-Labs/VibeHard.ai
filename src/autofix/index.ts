/**
 * Auto-fix loop (PROJECT_BRIEF.md §15). Gate-flag → propose fix → re-gate →
 * bounded retries → escalate. The gate disposes; the LLM/dep-bump only proposes.
 */
export { autoFix, type AutoFixOptions, type AutoFixResult, type GateRunner } from "./autofix.ts";
export { defaultFixer, type Fixer, type DefaultFixerOptions } from "./fixer.ts";
export { applyDepBumps, parseDepFinding, pickBumpTarget, type DepBumpResult } from "./depbump.ts";
