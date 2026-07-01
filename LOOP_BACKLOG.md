# VibeHard launch-loop — backlog

The autonomous loop does **the single top unchecked `- [ ]` item per run**, then marks it
`- [x]` in the SAME commit. Each item is sized to finish, test, and commit in ONE run.
If an item turns out too big, split it: do a smaller self-contained piece, leave the
rest as a new `- [ ]` item below. Never start work that can't be committed green this run.

Done-criteria for EVERY item: `bun run typecheck` + `bun test` green, change is behind an
existing seam (no redesign), a test covers it, and `scripts/loop-run.sh finish` committed it.

## Next up (ordered — do the top one)

- [ ] **#33b — record/secrets stores from the same factory.** Extend the factory so
  per-tenant `PgRecordStore`/`PgSecretsStore` are used when `DATABASE_URL` is set (scoped by
  tenant id), else the file stores. Test the selection logic with an injected `Sql`. No live DB.
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
