# VibeHard launch-loop — backlog

The autonomous loop does **the single top unchecked `- [ ]` item per run**, then marks it
`- [x]` in the SAME commit. Each item is sized to finish, test, and commit in ONE run.
If an item turns out too big, split it: do a smaller self-contained piece, leave the
rest as a new `- [ ]` item below. Never start work that can't be committed green this run.

Done-criteria for EVERY item: `bun run typecheck` + `bun test` green, change is behind an
existing seam (no redesign), a test covers it, and `scripts/loop-run.sh finish` committed it.

## Next up (ordered — do the top one)

(none — every code-only item is done; everything left needs Adam's accounts/credentials, below)

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
- [x] **#32a — sandbox gating.** `runVerify`'s container path (`src/gate/verify.ts`) now prefers
  an isolated, ephemeral Fly machine (`runInFlySandbox`, `src/substrate/fly-sandbox.ts`) over
  building/running the untrusted Docker image on the platform host — the whole point of the
  sandbox primitive, previously built but wired nowhere. Extracted the gating logic as its own
  pure `resolveSandboxHost(injected)` function (injected host always wins → tests never touch
  real Fly; else a real `FlyHostProvider` when `FLY_API_TOKEN` is set; else `undefined` → the
  EXISTING local-docker path, unchanged, so every current test/CI run — none of which set
  `FLY_API_TOKEN` — is unaffected). `summarizeSandbox()` maps the sandbox result to a `Finding`,
  mirroring `summarizeBuild`'s shape. Tests are fully pure — no docker, no real Fly/network call
  either direction, per the item's own "test the gating decision only" instruction. Only the
  CONTAINER path is sandboxed this increment (the one shape `runInFlySandbox` already fits — a
  Dockerfile-having workspace); the node-launch/build-only paths still run `npm install`/`npm run
  build` on-host and would need a different, larger redesign to sandbox (no Dockerfile to deploy)
  — noted as a real follow-up, not silently dropped. `bun test` = 896 pass / 0 fail, typecheck
  clean. ⚠️ Behavior change worth knowing: since `FLY_API_TOKEN` is ALREADY set in the real
  `.env`, the next time a container-kind app runs through `verify` (CLI or the hosted server),
  it will now automatically spin up + tear down a real, briefly-billed Fly machine — not
  hypothetical, this is live the moment this commit is running code.
- [x] **#deploy1/#deploy2/#package1 — Dockerfile + fly.toml + `start` script.** Added a `start`
  script (`bun web/server.ts`) to `package.json` so the Dockerfile CMD references a stable name
  instead of a hardcoded path duplicated in two places. `Dockerfile`: `oven/bun:1`, installs
  `--production` (no devDependencies at runtime), `PORT=8080`, `CMD ["bun", "run", "start"]`.
  Added `.dockerignore` (`.env`/`.env.*` excluded — .env must never enter the build context even
  though it's gitignored, since docker build context isn't governed by .gitignore). `fly.toml`:
  app name `vibehard-platform` (a PLACEHOLDER — Fly app names are globally unique, may need
  renaming before the real `fly launch`), `primary_region = "iad"`, `internal_port = 8080`,
  health check on `/app` (the same endpoint already smoke-tested green in #33e). Config only —
  no `docker build`, no `fly launch`, no `fly deploy`, nothing pushed or created. Docker's CLI is
  present in this sandbox but its daemon isn't running, so the Dockerfile was hand-reviewed, NOT
  build-tested live — flagged to Adam to run `docker build -t vibehard-platform .` himself once
  before the real deploy. `bun test` = 896 pass / 0 fail (files are non-code, but ran verify
  anyway per the harness's own discipline).
