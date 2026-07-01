# VibeHard launch-loop — running journal

Newest entries on top. One entry per run. Keep the tree clean at the end of every run.

## 2026-06-28 — durable tenant store wired via `Platform.open()` (EPIC #33, increment 5)
Added a static async factory `Platform.open(opts)` that wires the durable `PgTenantStore`
(via `openDb()` → managed Postgres on `DATABASE_URL`, else embedded disk Postgres) as the
default tenant store, returning `{ platform, db }` so the caller owns the db lifecycle. An
explicitly-supplied `tenants` store still wins, so every existing test/path is unchanged —
purely additive behind the constructor seam. Exported `openDb`/`Db`/`PgTenantStore` from the
platform barrel. Two new tests in `platform.test.ts`: signup survives an open→close→reopen
(restart simulation) in embedded mode, and the injected-store-wins path. `bun test` = 884
pass / 0 fail, `bun run typecheck` clean. Commit scoped to platform.ts + index.ts +
platform.test.ts + this journal.
**Next increment:** flip `web/server.ts`'s module-level `new Platform({...})` to
`await Platform.open({...})` so the hosted server actually uses the durable store (needs
making web init async — top-level await or an async bootstrap fn; close `db` on shutdown).

## 2026-06-28 — async-flip SALVAGED + loop hardened (interactive, with Adam)
The first batch of ~9 autonomous runs (14:07–18:36Z) **thrashed**: they made the
async-flip source edits across 8 files but never finished, never committed, never wrote
this journal, and left a broken dirty tree (tests + tsc red — test files weren't updated
to `await` the now-async calls; `cli.ts` had two un-awaited `projectCount` calls). Root
cause: the async-flip was too big to finish in one 30-min run, so the loop never reached
its commit/journal step, and each run inherited and extended the prior run's half-done WIP
instead of reverting it.

Fixed interactively:
- Completed the async-flip (updated `cli.ts` + the platform/tenant-store/billing-webhook
  tests). `bun test` = 882 pass / 0 fail, `bun run typecheck` clean.
- Committed as `ca86369` (EPIC #33, increment 4). Scoped to exactly the 11 async-flip
  files — the untracked audit docs / `landing/` site were NOT swept in.
- Hardened this loop's SKILL.md: increments must be completable in ONE run; never leave a
  dirty tree (revert if not green); never `git add -A`; always write this journal.

**State:** branch `fix/build-correctness-and-diagnose` @ `ca86369`, clean tree, build green.
**Next increment (do this first):** swap file stores → Postgres when `DATABASE_URL` is set,
behind the existing `Platform`/`web` constructor seams (use `openDb()` + the `Pg*Store`
classes that already exist + are tested). Small, additive, one test. See SKILL.md task #1.

## 2026-07-01T15:15:47Z — DONE
feat: #33a store factory — Platform constructor sql seam wires PgTenantStore (EPIC #33)
