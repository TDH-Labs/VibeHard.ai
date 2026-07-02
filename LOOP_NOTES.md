# VibeHard launch-loop — running journal

Newest entries on top. One entry per run. Keep the tree clean at the end of every run.

## 2026-07-01 — #32a sandbox gating: container verify path isolated from the host (increment 11)
`runVerify`'s container branch (`src/gate/verify.ts`) now prefers an ephemeral Fly machine
(`runInFlySandbox`) over building/running the untrusted Docker image locally — gated by a new
pure `resolveSandboxHost(injected)` helper (injected host wins in tests → zero real Fly/network
calls either direction; else a real `FlyHostProvider` when `FLY_API_TOKEN` is set; else
`undefined` → today's local-docker path, unchanged, so every existing test/CI run is unaffected).
`summarizeSandbox()` maps the result to a `Finding`. Only the CONTAINER path is sandboxed — the
node-launch/build-only paths (`npm install`/`npm run build` on-host) don't have a Dockerfile to
hand `runInFlySandbox`, so sandboxing them needs a different, larger design; left as a real,
explicit follow-up rather than silently dropped. `bun test` = 896 pass / 0 fail. Commit `d383d7c`.

**⚠️ Live behavior change, not hypothetical:** `.env`'s `FLY_API_TOKEN` is already set, so the
NEXT container-kind app that goes through `verify` (CLI or the hosted server) will automatically
spin up + tear down a real, briefly-billed Fly machine. This is the intended, documented epic
behavior (same env-gating convention every other Fly/Vercel/Supabase integration in this codebase
already uses) — not something done without authorization — but it's a genuine behavior/cost
change worth Adam's explicit awareness, surfaced directly in the session summary, not buried here.

**Session summary (2026-07-01, full session):** picked up directly (no Hermes handoff) from a
stalled scheduled run, completed EPIC #33 durable state end-to-end (#33a-d), found + fixed the
critical gap that made all of it inert in production (`web/server.ts` never called
`Platform.open()` — #33e), ran a real launch-readiness audit by reading the actual code paths a
signup would hit (not guessing), and closed #32a's container-path sandbox gating. 8 commits,
tests went 891→896, typecheck clean throughout, zero thrashing. Remaining gaps are ALL either (a)
credentials/accounts only Adam holds (`SUPABASE_ACCESS_TOKEN` — critical, blocks every tenant's
first deploy; `DATABASE_URL`; `STRIPE_WEBHOOK_SECRET`; `CLERK_PUBLISHABLE_KEY`; a git remote; a
domain), or (b) explicitly out of scope for an agent to do alone (the first paid `fly deploy`).
See LOOP_BACKLOG.md's "Blocked" section for the itemized, file:line-precise list.

## 2026-07-01 — web/server.ts wired to Platform.open() + real launch-readiness audit (increment 10 / #33e)
Adam: "figure out why this isn't ready on a server somewhere for users to sign up." Instead of
grinding the next backlog item blind, did a direct investigation of the actual running
production entrypoint and its real `.env` (boolean presence checks only — no values read/printed):

- **`web/server.ts` never adopted this session's EPIC #33 work.** Still had
  `new Platform({ baseDir: ROOT, billing: stripeBilling })` — the synchronous, file-backed
  constructor. All of #33a-d was fully built, tested, and completely inert in the one process
  that actually runs in production. FIXED: `const { platform, db: platformDb } = await
  Platform.open({...})` (top-level await — package is `"type": "module"`, Bun supports it
  natively) + `SIGTERM`/`SIGINT` handlers that call `await platformDb.close()` (a container
  stop/redeploy sends SIGTERM, not a clean process.exit). VERIFIED BY ACTUALLY BOOTING IT
  (`bun web/server.ts`), not just typecheck: got `HTTP 200` on `/app`, confirmed the embedded
  pglite data directory materialized as real Postgres files on disk at `~/.vibehard/db`, and
  confirmed SIGTERM closes cleanly. This is the highest-leverage fix in the whole session — it's
  what actually turns EPIC #33 on.
- **A real signup would fail on their first deploy TODAY**, independent of DATABASE_URL:
  `Platform.deployForTenant` always forces `managed: true`, and managed mode constructs a
  `SupabaseManagementClient` which throws `"missing SUPABASE_ACCESS_TOKEN"` if unset
  (`src/substrate/supabase-management.ts:65`) — confirmed by reading the code path, not assumed.
  `.env`'s `SUPABASE_ACCESS_TOKEN` is unset. This is a credential-only blocker (the code is
  already correct/fail-closed) — added to LOOP_BACKLOG.md's "Blocked" section with the exact
  file:line so it's unambiguous, not vague "needs Supabase creds."
- **No sandbox isolation** (`#32a`, already tracked, unchanged) — untrusted generated builds run
  as a plain child process on the host today.
- **`.env.example` was missing `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `VIBEHARD_STRIPE_PRICE_MAP`** entirely, despite all being real load-bearing vars in shipped
  code. Documented all four + upgraded the `SUPABASE_ACCESS_TOKEN` comment to state the forced-
  managed-mode requirement plainly.
- **Stale backlog item found and removed:** the old `#36a — Stripe checkout endpoint` item
  claimed this was still TODO. It's not — `/api/billing/checkout` + `/api/billing/webhook` are
  fully built in `web/server.ts` (confirmed by reading the code). Moved the REAL remaining gap
  (missing `STRIPE_WEBHOOK_SECRET`/`VIBEHARD_STRIPE_PRICE_MAP` — checkout sessions can be
  created but the plan never syncs after payment) into "Blocked — needs Adam." Lesson: verify
  LOOP_BACKLOG.md's claims against actual code before trusting them as the task list — it can
  drift stale, same as any todo list nobody re-audits against reality.
- **No git remote configured at all** (`git remote -v` empty) — CI has never run, there's no
  git-based deploy pipeline possible, and nothing is backed up off this machine. Needs Adam
  (repo creation is an account action, and push always needs explicit authorization anyway).

`bun test` = 891 pass / 0 fail, typecheck clean throughout. Commit `f9f7fce`.

**Net effect:** the code-only gaps are now closed as far as they can go without secrets/accounts
only Adam holds. What remains is entirely operator config + accounts, itemized precisely (with
file:line where relevant) in LOOP_BACKLOG.md's "Blocked" section — not vague "needs more setup."

**Next increment:** #32a — sandbox gating. See LOOP_BACKLOG.md.

## 2026-07-01 — EPIC #33 durable state COMPLETE (increment 9 / backlog #33d)
`Platform` now retains its constructor's `sql` as a private field, and `deployForTenant` passes
`sql: this.sql, scope: tenantId` into `this.deploy(...)`'s opts — closing the gap #33c's note
flagged: a `Platform` opened via `Platform.open()` now ALSO deploys its tenants' apps through the
Pg-backed secrets/records stores (#33b/#33c), scoped per tenant, not just the Pg-backed tenant
store (#33a). Two tests: a `Platform` built with a real pglite-backed `sql` (signup goes through
`PgTenantStore`, proving the constructor seam end-to-end) deploys through an injected `deploy` fn
whose captured opts carry the SAME `sql` + `scope: tenantId`; a second confirms `sql` stays
`undefined` when the Platform wasn't given one (file-backed default unchanged). `bun test` = 891
pass / 0 fail, typecheck clean. Commit `a10b88d`.

**EPIC #33 is now fully wired end-to-end**, all four sub-increments (#33a tenants, #33b secrets,
#33c records + the RecordStore async-flip, #33d threading) behind existing constructor/opts
seams, unit-tested against embedded pglite, zero live `DATABASE_URL` required to exercise any of
it. What's left before this is exercised against a REAL managed Postgres: nothing on the code
side — that's launch-blocker territory (Adam needs to provide `DATABASE_URL`; see HANDOFF.md §5).

**Next increment:** #32a — sandbox gating (wire `runInFlySandbox` into the build/verify path
behind `FLY_API_TOKEN`). See LOOP_BACKLOG.md.

## 2026-07-01 — secrets + records durable stores wired (EPIC #33, increments 7-8 / backlog #33b, #33c)
Continued straight through from increment 6 in the same session (Adam: "we never handed off, I
want you to continue" — no Hermes handoff this round).

**#33b (secrets):** `defaultSubstrateDeps` (`src/substrate/deploy-app.ts`) gained `sql?: Sql` +
`scope?: string`; when `sql` is set it builds `PgSecretsStore(sql, passphrase, scope)` instead of
`LocalEncryptedSecretsStore`. `PgSecretsStore` already satisfied the async `SecretsStore`
interface, so this was a clean drop-in. Threaded through `DeployAppOptions`/`deployApp`. Commit
`a01c8ec`.

**#33c (records):** Discovered `RecordStore` was still a SYNC interface (9 call sites in
`orchestrator.ts`), so `PgRecordStore` (already async) didn't structurally fit — split this out
rather than force it into #33b. Flipped `RecordStore` to async: `orchestrator.ts`'s
`provisionAndDeploy`/`destroy` were already `async` functions, so every call site just needed an
`await` added (not a redesign) — this is NOT the same risk shape as the original Platform
async-flip (ca86369), which had to flip previously-sync callers. Updated 4 test files with sync
fakes (`record.test.ts`, `orchestrator.test.ts`, `deploy-app.test.ts`, `platform.test.ts`). Came
back green in one pass (889/889), so — per the backlog item's own contingency — also wired
`PgRecordStore(sql, scope)` into `defaultSubstrateDeps` in the same run, mirroring #33b's pattern
exactly. Commit `a9adfb9`.

**EPIC #33 status:** all three durable-state seams (tenants/secrets/records) now select Postgres
vs. file-backed behind the same `sql`/`scope` factory pattern, unit-tested against embedded
pglite, zero live `DATABASE_URL` needed. NOT yet wired end-to-end: `Platform.deployForTenant`
doesn't currently pass its own `sql` through to `this.deploy(...)`'s `opts` — so a `Platform`
opened via `Platform.open()` (durable tenants) still deploys apps with file-backed
secrets/records unless the caller explicitly passes `sql`/`scope` into `deployForTenant`'s opts.
That's a small follow-up (thread `this.sql` — Platform would need to retain it as a field — into
`deployForTenant`'s call to `this.deploy`) but is genuinely a distinct, separately-testable slice;
left as a new backlog item rather than scope-creeping this run further.

## 2026-07-01 — store factory: constructor `sql` seam (EPIC #33, increment 6 / backlog #33a)
Adam asked to continue directly (no Hermes handoff) after noticing a stalled scheduled run
(journal shows a `START @ 93858b2` at 15:10:41Z with no matching `finish`/`abort` — the
tool-permission-approval gap flagged in HANDOFF.md §3 struck again). Recovered per the
harness's own design: confirmed no live `loop-run.sh` process held the lock (`ps aux`), then
manually released the stale `.loop.lock` (same effect as the 90-min auto-steal, just judged
safe early since the leftover WIP was a 4-line fragment) and ran `start` clean.

Implemented #33a: `PlatformOptions` gained `sql?: Sql`; the constructor now does
`opts.tenants ?? (opts.sql ? new PgTenantStore(opts.sql) : new FileTenantStore(...))` — a
synchronous constructor-level seam, distinct from the existing async `Platform.open()`
factory (which resolves `DATABASE_URL`/embedded pglite via `openDb()`). `Platform.open()`
simplified to `new Platform({ ...opts, sql: opts.sql ?? db.sql })`, reusing the same seam
instead of constructing `PgTenantStore` itself. New test: a `Platform` built with an injected
in-memory pglite `Sql` (matching the `freshSql()` pattern in `pg-store.test.ts`) signs up a
tenant and reads it back via `getTenant`. `bun test` = 885 pass / 0 fail, typecheck clean.
Committed `0aa972b` via `scripts/loop-run.sh finish`.

**Next increment:** #33b — extend the same factory so per-tenant `PgRecordStore`/
`PgSecretsStore` are selected when `sql` is present (scoped by tenant id), else the file
stores, behind `Platform`'s existing per-tenant store accessors. See LOOP_BACKLOG.md.

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

## 2026-07-01T15:21:09Z — DONE
feat: #33b secrets store factory — PgSecretsStore wired into defaultSubstrateDeps (EPIC #33)

## 2026-07-01T15:26:38Z — DONE
feat: #33c RecordStore async-flip + PgRecordStore wired into defaultSubstrateDeps (EPIC #33)

## 2026-07-01T15:30:43Z — DONE
feat: #33d thread Platform's sql/tenant scope into deployForTenant (EPIC #33 complete)

## 2026-07-01T15:41:49Z — DONE
feat: web/server.ts adopts Platform.open() (durable store finally live) + document undocumented env vars

## 2026-07-01T15:50:27Z — DONE
feat: #32a sandbox gating — container verify path prefers an ephemeral Fly machine over the host (EPIC #32)

## 2026-07-01T16:43:11Z — DONE
feat: #deploy1/#deploy2/#package1 — Dockerfile, fly.toml, start script (config only, no deploy)

## 2026-07-01T17:32:40Z — DONE
fix: CI failure — deploy-app.test.ts stubs Supabase/secrets env hermetically (not ambient .env)

## 2026-07-01T20:04:27Z — DONE
feat: enable allow_promotion_codes on checkout so coupon codes (e.g. beta testers) actually work

## 2026-07-01T20:35:20Z — DONE
fix: embedded pglite fallback ENOENT on a fresh container filesystem (recursive mkdir)

## 2026-07-01T23:48:02Z — DONE
fix: serve the app UI at the bare root path (was 404 — only /app and /reset were handled)

## 2026-07-02T00:51:07Z — DONE
fix: login loop — validate Clerk sessions + CSRF origin against ALL served hostnames, and fail loudly instead of remounting SignIn

## 2026-07-02T02:04:47Z — DONE
feat: turnkey onboarding — product-first dashboard, platform LLM key by default, BYO keys/services tucked into Advanced

## 2026-07-02T02:18:13Z — DONE
feat: sustainable turnkey quotas — build caps sized so worst-case platform token spend stays under plan price

## 2026-07-02T02:30:26Z — DONE
feat: OpenRouter as first-class LLM provider (openrouter→opencode→anthropic resolution, total BYO override, same model families)

## 2026-07-02T02:36:59Z — DONE
feat: new marketing site at root — seven-gates craftsmanship tour, honest-copy homepage (positioning.md-bound); app moves to /app

## 2026-07-02T03:59:56Z — DONE
fix: SECURITY_AUDIT_4 D-1 — sensitive-data classification is now falsifiable (code scan can't be switched off by the spec); build gate requires artifacts; completeness docstring corrected

## 2026-07-02T04:17:03Z — DONE
fix: add sensitive-signals module missing from 65b8c38 (new files need explicit git add — the D-1 commit was incomplete without them)
