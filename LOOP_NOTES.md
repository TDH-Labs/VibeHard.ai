# VibeHard launch-loop — running journal

Newest entries on top. One entry per run. Keep the tree clean at the end of every run.

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
