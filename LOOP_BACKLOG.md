# VibeHard launch-loop — backlog

The autonomous loop does **the single top unchecked `- [ ]` item per run**, then marks it
`- [x]` in the SAME commit. Each item is sized to finish, test, and commit in ONE run.
If an item turns out too big, split it: do a smaller self-contained piece, leave the
rest as a new `- [ ]` item below. Never start work that can't be committed green this run.

Done-criteria for EVERY item: `bun run typecheck` + `bun test` green, change is behind an
existing seam (no redesign), a test covers it, and `scripts/loop-run.sh finish` committed it.

## Next up (ordered — do the top one)

- [ ] **#32a — sandbox gating.** Wire `runInFlySandbox` (`src/substrate/fly-sandbox.ts`) into
  the build/verify path so untrusted generated build+boot runs isolated WHEN `FLY_API_TOKEN`
  is present; fall back to local execution when absent. Test the gating decision only — DO NOT
  run a live deploy. Security-relevant before public signup: today builds run as a plain child
  process on the host (no isolation from a stranger's generated code).
- [ ] **#deploy1 — platform Dockerfile.** Add a `Dockerfile` that runs `web/server.ts` on the
  Bun runtime, reading `DATABASE_URL` + the existing env vars. Config only; do not build/push.
- [ ] **#deploy2 — platform fly.toml.** Add a `fly.toml` for the platform web app (internal
  port, health check, env passthrough). Config only; do not deploy.
- [ ] **#package1 — add a `start` script.** `package.json` has `test`/`typecheck` but no way to
  boot the web server other than knowing to run `bun web/server.ts` directly. Add
  `"start": "bun web/server.ts"` (trivial, but a real Dockerfile/fly.toml CMD should reference
  a script name, not a hardcoded path duplicated in two places).

## Blocked — needs Adam (do NOT attempt; listed so the loop skips them)

- [ ] managed Postgres `DATABASE_URL` → code is fully wired (EPIC #33 + #33e below); without it,
  the web server now falls back to EMBEDDED disk-persisted Postgres (`~/.vibehard/db`) instead of
  in-memory files, which is real durability on a persistent volume but still wiped on most PaaS
  containers without a mounted disk. Needed for true cloud durability.
- [ ] **`SUPABASE_ACCESS_TOKEN`/`SUPABASE_PAT`** → 🔴 CRITICAL, distinct from the DATABASE_URL
  gap: `Platform.deployForTenant` FORCES managed mode for every tenant, and managed mode throws
  `"missing SUPABASE_ACCESS_TOKEN"` the moment `SupabaseManagementClient` is constructed — a real
  user's FIRST "build an app" click fails outright without this. Verified by reading the code
  path directly (`src/substrate/supabase-management.ts:65`), not assumed. Get a PAT from
  supabase.com/dashboard/account/tokens.
- [ ] Stripe: `STRIPE_WEBHOOK_SECRET` + `VIBEHARD_STRIPE_PRICE_MAP` → the checkout endpoint
  (`/api/billing/checkout`) and provider code are ALREADY BUILT (contrary to this backlog's
  former #36a item, which was stale — removed). `STRIPE_SECRET_KEY` is set, so checkout SESSIONS
  can be created, but without `STRIPE_WEBHOOK_SECRET` the webhook that syncs `tenant.plan` after
  payment 503s — a paying customer's plan would never actually upgrade. See
  docs/BILLING_AND_HOSTING_SETUP.md for the full Stripe dashboard steps.
- [ ] `CLERK_PUBLISHABLE_KEY` → `CLERK_SECRET_KEY` is set but its pair isn't; Clerk requires BOTH
  to activate (by design — see `src/auth/clerk.ts`), so auth is currently on the legacy
  email/password path, not broken, just not what was probably intended.
- [ ] domain + Clerk production instance → required for public launch.
- [ ] **a git remote** → this repo has NEVER been pushed anywhere (`git remote -v` is empty);
  the CI workflow (`.github/workflows/ci.yml`) has therefore never run, and there's no git-based
  deploy pipeline possible yet. Needs Adam to create the remote (repo creation is an account
  action) before pushing — the loop must never push without explicit authorization anyway.
- [ ] explicit go-ahead for the first PAID `fly deploy` → the loop must never deploy/spend.

## Done

- [x] **#33a — store factory.** `Platform`'s constructor now accepts `sql?: Sql`; when set (and
  no explicit `tenants` given) it builds `PgTenantStore(sql)`, else falls back to
  `FileTenantStore`. `Platform.open()` simplified to pass `sql: db.sql` through the same seam.
  Test: constructor injected with a pglite `Sql` signs up + reads back a tenant. Commit `0aa972b`.
- [x] **#33b — secrets store from the same factory (split from records; see #33c).**
  `defaultSubstrateDeps` (`src/substrate/deploy-app.ts`) now accepts `sql?: Sql` + `scope?: string`;
  when `sql` is set it builds `PgSecretsStore(sql, passphrase, scope)`, else the existing
  `LocalEncryptedSecretsStore`. Threaded through `DeployAppOptions`/`deployApp`. `PgSecretsStore`
  already satisfied the async `SecretsStore` interface, so this was a clean drop-in; `PgRecordStore`
  did NOT (RecordStore is still sync) — split out as #33c rather than force an oversized increment.
  Test: file-backed by default, Pg-backed + tenant-scoped round-trip with an injected pglite `Sql`.
- [x] **#33c — RecordStore async-flip + PgRecordStore wiring.** `RecordStore`
  (`src/substrate/types.ts`) flipped to async (`get/put/remove` → `Promise<...>`); all 9 call
  sites in `orchestrator.ts` (`provisionAndDeploy` + `destroy`, both already `async` functions, so
  this was a mechanical `await` addition, not a redesign) now await. `FileRecordStore` methods
  marked `async`. Updated the 4 consumers with sync fakes/calls: `record.test.ts`,
  `orchestrator.test.ts`'s `memRecords()` fake, `deploy-app.test.ts`'s inline fake,
  `platform.test.ts`'s isolation test. The flip alone came back 887/887 green in one pass (no
  thrashing, unlike ca86369), so — per its own contingency note — completed the full item in the
  same run: wired `PgRecordStore(sql, scope)` into `defaultSubstrateDeps` alongside the #33b
  secrets selection (same `sql`/`scope` option, same pattern). Test: file-backed by default,
  Pg-backed + tenant-scoped round-trip. `bun test` = 889 pass / 0 fail, typecheck clean.
- [x] **#33d — thread `sql` from Platform into deployForTenant.** `Platform` now retains its
  constructor's `sql` as a private field; `deployForTenant` passes `sql: this.sql, scope: tenantId`
  into `this.deploy(...)`'s opts, so a `Platform` opened via `Platform.open()` (durable tenants)
  now ALSO deploys with Pg-backed secrets/records (#33b/#33c), scoped per tenant — closing the gap
  the #33c note flagged. Test: a `Platform` constructed with a real pglite-backed `sql` (through
  which signup goes via `PgTenantStore`, proving the constructor seam end-to-end) deploys through
  an injected `deploy` fn whose captured opts show the SAME `sql` + `scope: tenantId`; a second
  test confirms `sql` stays `undefined` when the Platform wasn't given one (file-backed path
  unchanged). EPIC #33 durable state is now fully wired end-to-end behind existing seams — every
  piece is additive/opt-in and needs no live `DATABASE_URL` to exercise. `bun test` = 891 pass /
  0 fail, typecheck clean.
- [x] **#33e — web/server.ts actually USES the durable store.** Found by direct investigation
  (Adam: "figure out why this isn't ready for users"), not by following the backlog list:
  `web/server.ts` still did `new Platform({...})` — the synchronous, file-backed constructor —
  meaning ALL of #33a-d was inert in the one process that actually runs in production. Flipped
  to `const { platform, db: platformDb } = await Platform.open({...})` (top-level await; the
  package is `"type": "module"`, Bun supports it natively) + added `SIGTERM`/`SIGINT` handlers
  that close `platformDb` cleanly (a container stop/redeploy sends SIGTERM). Verified by actually
  BOOTING the server (`bun web/server.ts`), confirming `HTTP 200` on `/app`, confirming the
  embedded pglite data directory materializes on disk at `~/.vibehard/db` (real Postgres files,
  not a stub), and confirming the SIGTERM handler fires and closes cleanly — not just typecheck.
  Also documented the previously-undocumented `DATABASE_URL`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `VIBEHARD_STRIPE_PRICE_MAP` in `.env.example` (none were there despite
  being real, load-bearing vars), and upgraded the `SUPABASE_ACCESS_TOKEN` comment to state
  plainly that it's required for any tenant deploy (managed mode is forced, and throws without
  it — see the "Blocked" section below). `bun test` = 891 pass / 0 fail, typecheck clean.
