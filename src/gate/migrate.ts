/**
 * Re-export shim (2026-07-10 extraction) — now lives in @vibehard/gate-check.
 * Kept at this path so every existing internal import (`../gate/migrate.ts`) needs zero changes.
 */
export { migrateGate, runMigrate, SUPABASE_STUBS, neutralize, extensionsIn, type MigrateOptions } from "@vibehard/gate-check";
