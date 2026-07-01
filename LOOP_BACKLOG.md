# VibeHard launch-loop — backlog

The autonomous loop does **the single top unchecked `- [ ]` item per run**, then marks it
`- [x]` in the SAME commit. Each item is sized to finish, test, and commit in ONE run.
If an item turns out too big, split it: do a smaller self-contained piece, leave the
rest as a new `- [ ]` item below. Never start work that can't be committed green this run.

Done-criteria for EVERY item: `bun run typecheck` + `bun test` green, change is behind an
existing seam (no redesign), a test covers it, and `scripts/loop-run.sh finish` committed it.

## Next up (ordered — do the top one)

- [ ] **#33c — RecordStore async-flip, then PgRecordStore.** `RecordStore` (`src/substrate/types.ts`)
  is still a SYNC interface (`get/put/remove` return non-Promise) — confirmed by 9 sync call sites
  in `src/substrate/orchestrator.ts` (`deps.records.get/put/remove`) plus the sync fake in
  `deploy-app.test.ts`. `PgRecordStore` (`src/platform/pg-store.ts`) is already async, so it does
  NOT structurally satisfy `RecordStore` today — this is why #33b split records out. Do this as
  its OWN increment (same shape as the original Platform async-flip, ca86369): flip `RecordStore`
  to async, `await` the 9 call sites in `orchestrator.ts`, update `deploy-app.test.ts`'s fake +
  any other sync `RecordStore` implementers/tests, THEN wire `PgRecordStore` into
  `defaultSubstrateDeps` behind the `sql`/`scope` option added in #33b (mirror the secrets-store
  selection). If the async-flip alone doesn't finish green in one run, land it alone first and
  leave the `PgRecordStore` wiring as a follow-up item — do not let it thrash like ca86369 did.
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
