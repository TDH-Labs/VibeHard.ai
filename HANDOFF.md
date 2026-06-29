# VibeHard / drydock — launch handoff (for Hermes)

**Owner:** Adam. **Date:** 2026-06-28. **Repo:** `~/dev/drydock`.
**Definition of done (Adam's words):** *"sitting on the cloud somewhere and anyone, anywhere
could sign up as a user and get their own place to build apps, and we are able to charge for
services."* Cloud-hosted, multi-tenant, self-serve signup, billing live.

---

## 0. Read these first (context)
- `/Users/ai/.claude/projects/-Users-ai-workspace-agent-environment/memory/drydock-production-readiness.md` — epics, build-vs-buy decisions, progress.
- `drydock-security-audits.md` (same memory dir) — 3 audits, all remediated.
- `LOOP_BACKLOG.md` (repo root) — the ordered, atomic task queue. **This is the to-do list.**
- `LOOP_NOTES.md` (repo root) — committed milestone journal.

## 1. Current state — GREEN
- Branch: **`fix/build-correctness-and-diagnose`** (NEVER work on / push to `main`; never force-push; never push to a remote at all without Adam).
- HEAD `6c4dae1`. `bun test` = **882 pass / 0 fail**, `bun run typecheck` clean.
- Recent commits: `ca86369` async-flip (Platform/TenantStore/web/cli → async), `ac227ca` LOOP_NOTES, `6c4dae1` reliability harness.
- Verify anytime: `cd ~/dev/drydock && bash scripts/loop-run.sh verify` (= typecheck + test).

## 2. What's already BUILT (don't rebuild)
- **Security:** 3 external audits remediated. Gate chain (sast/secrets/depvuln/rls/migrate/rls-enforce/compliance/pii/prod-readiness/verify/completeness).
- **Auth:** Clerk, env-gated on `CLERK_SECRET_KEY` + `CLERK_PUBLISHABLE_KEY`. `src/auth/clerk.ts` + `web/server.ts`. Inert without keys (legacy auth). Live sign-in verified in browser. Clerk app id `app_3FkL2qgSyEFqgFE95LtL0AIUYp1`.
- **Durable state (EPIC #33, in progress):** `src/platform/pg-store.ts` (PgTenantStore/PgRecordStore/PgSecretsStore), `src/platform/db.ts` (`openDb()` → managed PG via `DATABASE_URL`, else pglite-on-disk), `src/substrate/seal.ts` (AES-256-GCM). Platform/stores are now **async**. NOT yet wired: the file→PG swap when `DATABASE_URL` is set (that's backlog #33a/#33b).
- **Sandbox primitive:** `src/substrate/fly-sandbox.ts` (`runInFlySandbox`) — built, not yet wired into the build path (#32a).
- **Eval harness:** `src/eval/harness.ts` + `vibehard eval`. **CI:** `.github/workflows/ci.yml`.

## 3. The autonomous loop + its reliability harness (IMPORTANT)
A scheduled task **`vibehard-launch-loop`** (every 30 min) runs an agent to advance the backlog
one increment per run. SKILL: `/Users/ai/.claude/scheduled-tasks/vibehard-launch-loop/SKILL.md`.

It thrashed earlier (made edits, never committed, left a dirty broken tree) because discipline
lived only in the prompt. Fixed by moving invariants into CODE (commit `6c4dae1`), proven with
14/14 adversarial tests:
- `scripts/loop-run.sh start` — reverts leftover WIP (every run starts from last green commit) + single-run lock.
- `scripts/loop-run.sh finish "<msg>"` — verifies, then commits-green OR reverts-entirely; tree always clean.
- `scripts/githooks/pre-commit` (active via `core.hooksPath=scripts/githooks`) — blocks any red commit.
- `LOOP_BACKLOG.md` — work pre-cut into atomic 1-run tasks.
- Telemetry: `.loop/journal.log` (gitignored, per-run); `LOOP_NOTES.md` (committed milestones).

**Net guarantee:** worst case of any run is a no-op the next `start` cleans up — never a broken/dirty tree.

### ⚠️ The one UNRESOLVED issue (this is why Adam is handing off)
The scheduled run likely **stalls waiting for tool permission** (git/bun/bash) because nothing
pre-approved them. I could not resolve *where* to approve from the desktop app UI:
- Adam couldn't find a "Scheduled" section in the sidebar.
- I tried to inspect the screen via computer-use but couldn't raise the Claude window above a
  read-only Safari window to see the actual UI.
- **Two possibilities to test:** (a) there's a Scheduled/Routines panel with "Run now" + a tool-approval
  step; or (b) the task simply prompts for approval on its FIRST run and remembers thereafter.
- **Recommended:** trigger ONE run while watching and approve the prompts as they appear; after that,
  unattended runs should proceed. Confirm via `git log` + `.loop/journal.log` that it produced a clean commit.

## 4. TO DO — critical path to launch (in order)
These are the `LOOP_BACKLOG.md` items; do the top open one per session, behind existing seams, tested + committed via `scripts/loop-run.sh finish`.
1. **#33a — store factory:** in `src/platform/platform.ts`, pick PG stores from `openDb()` when `DATABASE_URL` set, else file stores. Behind the constructor seam. One pglite-injected test. (No live DB needed.)
2. **#33b — record/secrets stores** from the same factory (scoped per tenant).
3. **#32a — sandbox gating:** wire `runInFlySandbox` into build/verify when `FLY_API_TOKEN` present, else local. Test the gating only; no live deploy.
4. **#deploy1 — Dockerfile** for `web/server.ts` (Bun runtime; reads `DATABASE_URL` + env). Config only.
5. **#deploy2 — fly.toml** for the platform web app. Config only.
6. **#36a — Stripe checkout endpoint** (`POST /api/billing/checkout`), env-gated on `STRIPE_SECRET_KEY`. Mock the client in test; no live keys.
7. Then: KMS secrets (#35), observability/edge (#37), connect/onboarding UX (#39), control-plane/legal (#40).

## 5. LAUNCH-BLOCKERS — need ADAM (cannot be done autonomously; never attempt)
- [ ] **Managed Postgres `DATABASE_URL`** (Neon/Supabase/Fly PG) → exercises #33 against a real DB + needed to deploy durably.
- [ ] **Stripe account + product price IDs** (+ `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `VIBEHARD_STRIPE_PRICE_MAP`) → finishes billing.
- [ ] **Domain** (e.g. vibehard.ai) + DNS.
- [ ] **Clerk production instance keys** → flips auth live in prod.
- [ ] **Explicit go-ahead for the first PAID `fly deploy`** → the loop/agents must never deploy or spend money on their own.

## 6. HARD CONSTRAINTS (non-negotiable)
- Never read/print/edit/commit `.env` (gitignored; holds real secrets). Never print any secret/key value in chat.
- Never `git add -A` / `git add .` (repo has untracked docs + a `landing/` site incl. binaries). Stage only files you changed.
- Never `git push`, never force-push, never touch `main`. Commits stay local on the feature branch.
- Never create accounts, run `fly deploy`, provision/destroy cloud resources, or spend money. Those are Adam's.
- Stay inside `~/dev/drydock`.
- ⚠️ Per Adam's standing rule: **do NOT edit/commit in `~/dev/drydock` without in-the-moment authorization** — this handoff + the loop are authorized; new ad-hoc changes are not. (See memory `feedback-vibehard-off-limits`.)

## 7. Quick commands
```
cd ~/dev/drydock
git status && git log --oneline -8
bash scripts/loop-run.sh verify          # typecheck + tests
bash scripts/loop-run.sh start           # begin a loop increment (clean + show next task)
bash scripts/loop-run.sh finish "feat: … (loop #xx)"   # verify → commit-green or revert
cat LOOP_BACKLOG.md LOOP_NOTES.md .loop/journal.log
```
