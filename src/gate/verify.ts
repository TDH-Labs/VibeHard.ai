/**
 * Re-export shim (2026-07-10 extraction) — now lives in @vibehard/gate-check.
 * Kept at this path so every existing internal import (`../gate/verify.ts`) needs zero changes.
 * The real Fly-sandbox-wired verify gate lives in `./index.ts` (`GATES`/`FAST_GATES`) — this file
 * only re-exports the deterministic, sandbox-agnostic helpers other subsystems reach for directly.
 */
export { installStale, safeToolEnv, isUp } from "@vibehard/gate-check";
