/**
 * Global test preload (bunfig.toml's `test.preload`) — runs before every test file.
 *
 * THE BUG THIS CLOSES (found live 2026-07-20): Bun auto-loads this repo's `.env` for `bun test`,
 * and in this dev environment `.env`'s DATABASE_URL is the LIVE PLATFORM's own production
 * database. fleet.ts's durable-store fix (sandbox-durability audit) added a tier that prefers
 * Postgres over a local file whenever DATABASE_URL is set — so a test suite run silently wrote
 * real rows into production's fleet_conventions/fleet_candidates tables via any test that
 * exercises the auto-fix loop (recordCandidate/recordResolution), none of which had ever needed
 * to isolate DATABASE_URL before, because there was previously no code path that could reach a
 * network database at all.
 *
 * Every OTHER test in this codebase that cares about DATABASE_URL already follows this same
 * discipline by hand (see platform/db.test.ts, platform/platform.test.ts) — explicitly delete/
 * restore it, never rely on an ambient value. This makes that the DEFAULT instead of something
 * each test file has to remember on its own; a test that specifically wants to exercise the
 * Postgres-backed path still can (against embedded pglite, or by setting DATABASE_URL itself).
 */
delete process.env.DATABASE_URL;
