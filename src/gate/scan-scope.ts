/**
 * Re-export shim (2026-07-10 extraction) — now lives in @vibehard/gate-check.
 * Kept at this path so every existing internal import (`../gate/scan-scope.ts`) needs zero changes.
 */
export { DERIVED_DIRS, hasAuthoredSource, relativizeFinding } from "@vibehard/gate-check";
