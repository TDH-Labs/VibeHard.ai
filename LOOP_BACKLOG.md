# VibeHard launch-loop — backlog

The autonomous loop does **the single top unchecked `- [ ]` item per run**, then marks it
`- [x]` in the SAME commit. Each item is sized to finish, test, and commit in ONE run.
If an item turns out too big, split it: do a smaller self-contained piece, leave the
rest as a new `- [ ]` item below. Never start work that can't be committed green this run.

Done-criteria for EVERY item: `bun run typecheck` + `bun test` green, change is behind an
existing seam (no redesign), a test covers it, and `scripts/loop-run.sh finish` committed it.

## Next up (ordered — do the top one)

- [ ] **#33d — thread `sql` from Platform into deployForTenant.** `Platform.deployForTenant`
  (`src/platform/platform.ts`) calls `this.deploy(workspacePath, {...opts, app, stateDir, managed})`
  but never passes `sql`/`scope` — so even a `Platform` opened via `Platform.open()` (durable
  tenants) still deploys apps with file-backed secrets/records (#33b/#33c stay dormant unless a
  caller manually threads `sql` into `deployForTenant`'s opts). Retain the constructor's `sql` as
  a private field on `Platform`, and pass `sql: this.sql, scope: tenantId` into the `this.deploy(...)`
  call in `deployForTenant`. Test: a `Platform` constructed with an injected `sql` deploys through
  the injected `deploy` fn and the opts it receives include `sql`/`scope: tenantId`.
- [ ] **#32a — sandbox gating.** Wire `runInFlySandbox` (`src/substrate/fly-sandbox.ts`) into
  the build/verify path so untrusted generated build+boot runs isolated WHEN `FLY_API_TOKEN`
  is present; fall back to local execution when absent. Test the gating decision only — DO NOT
  run a live deploy.
- [ ] **#deploy1 — platform Dockerfile.** Add a `Dockerfile` that runs `web/server.ts` on the
  Bun runtime, reading `DATABASE_URL` + the existing env vars. Config only; do not build/push.
- [ ] **#deploy2 — platform fly.toml.** Add a `fly.toml` for the platform web app (internal
  port, health check, env passthrough). Config only; do not deploy.
- [ ] **#36a — Stripe checkout endpoint.** Add a `POST /api/billing/checkout` that creates a
  Stripe Checkout Session for a plan price id (uses the existing `StripeClient`); env-gated on
  `STRIPE_SECRET_KEY`. Code + test (mock the client). No live keys, no real charge.

## Blocked — needs Adam (do NOT attempt; listed so the loop skips them)

- [ ] managed Postgres `DATABASE_URL` → required to exercise #33 against a real DB + to deploy.
- [ ] Stripe account + product price ids → required to finish billing end-to-end (#36).
- [ ] domain + Clerk production instance → required for public launch.
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
