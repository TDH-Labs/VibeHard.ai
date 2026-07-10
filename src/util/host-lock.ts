/**
 * Re-export shim (2026-07-10 extraction) — now lives in @vibehard/gate-check.
 * Kept at this path so every existing internal import (`../util/host-lock.ts`) needs zero changes.
 */
export { withHostLock } from "@vibehard/gate-check";
