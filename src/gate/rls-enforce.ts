/**
 * Re-export shim (2026-07-10 extraction) — now lives in @vibehard/gate-check.
 * Kept at this path so every existing internal import (`../gate/rls-enforce.ts`) needs zero changes.
 */
export { runRlsEnforcement, rlsEnforceGate, type EnforceOptions } from "@vibehard/gate-check";
