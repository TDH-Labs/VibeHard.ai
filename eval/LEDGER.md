# Failure-class ledger

The unknown-unknowns discovery mechanism (Phase 2). Every never-seen-before failure class from a
benchmark run becomes: (a) an entry here, (b) a minimal repro, and (c) either a template fix, a
deterministic check, or a new eval case. Append-only; classes are closed by naming the commit that
locks them with a test. The benchmark score (`vibehard benchmark`) is the only progress metric.

Format per entry:

```
## <class-slug>
- first seen: <date> · <run/build id> · <case id>
- symptom: what the run actually showed (gate + finding, verbatim where possible)
- root cause: from direct evidence, reproduced in isolation where possible
- fix: <layer that owns the decision> · <commit> · locked by <test>
- status: open | fixed | superseded-by <class>
```

---

## boilerplate.supabase-on-client-only
- first seen: 2026-07-11 · live pomodoro builds · pomodoro-timer
- symptom: architecture forced Supabase onto a client-only app; fix loop re-introduced it independently.
- root cause: no third option between "must use Supabase" and "local tool"; every codegen-capable site defaulted to Supabase.
- fix: architecture checks + shared NO_BACKEND_INSTRUCTION · dd85f3d, 41a663e, eb932d8, 13c39df · architecture/spec-review tests
- status: fixed (structurally superseded by golden templates, 3df3a19)

## boilerplate.missing-manifest
- first seen: 2026-07-12 · live build · pomodoro-timer
- symptom: no workstream ever assigned package.json; nothing installable.
- root cause: plans validated per-workstream, never as a whole.
- fix: no-project-manifest check · 1852282 · architecture.test.ts
- status: fixed (inverted under templates: template owns the manifest, 3df3a19)

## boilerplate.missing-root-layout
- first seen: 2026-07-12 · live build · pomodoro-timer
- symptom: app/ pages planned with no app/layout.tsx; Next build ENOENT.
- root cause: framework-required entry point not part of any plan check.
- fix: no-root-layout check · fd06a7a · architecture.test.ts
- status: fixed (inverted under templates, 3df3a19)

## boilerplate.tailwind-version-misdetect
- first seen: 2026-07-12 · live builds (several CSS failures) · pomodoro-timer
- symptom: v3 apps configured as v4 (and v4's postcss plugin never installed).
- root cause: detection regex was always-true for every input.
- fix: scaffoldConfigs rewrite · cc4170b · cli.test.ts
- status: fixed (templates pin Tailwind v3 exactly, 3df3a19)

## codegen.empty-workstream-silent-pass
- first seen: 2026-07-13 · /tmp/debug-e2e-9 · pomodoro-timer
- symptom: "Project Setup — 7 file(s)" streamed zero file actions and no error; proptest then
  reported "the app has no package.json"; 45 minutes of fix-loop improvisation → held.
- root cause: a model response with no parseable file actions yields no error event; nothing
  validated what codegen DELIVERS against what the plan ASSIGNS.
- fix: per-workstream post-condition (retry once, then abort) · 1af75bc · cli.test.ts (missingWorkstreamFiles)
- status: fixed

## deploy.port-contract-unenforced
- first seen: 2026-07-13 · /tmp/debug-e2e-9 · pomodoro-timer
- symptom: verify sandbox-boot-failed 502 across 4+ fix attempts; app healthy when booted with
  PORT=8080 by hand (reproduced in isolation 2026-07-17).
- root cause: fly.toml routes to internal_port 8080 but PORT was never injected; the finding
  never named the contract, so the fixer oscillated blind. Same latent bug in the local docker
  probe (later -e PORT overrides the pin).
- fix: substrate pins PORT=internalPort; containerRunArgs filters app PORT; finding states the
  contract · 0e16c7c · fly.test.ts + verify.test.ts
- status: fixed

## deps.clean-env-undeclared-dependency
- first seen: 2026-07-17 · /tmp/debug-e2e-10 · pomodoro-timer
- symptom: "On a clean machine (fresh copy, no node_modules), npm run build failed" across
  rounds; architect had also switched stacks between runs (Vite this time, Next before).
- root cause: LLM-authored manifest with no lockfile; per-run stack nondeterminism. Not
  root-caused deeper — the generation path was replaced by templates the same day.
- fix (structural): golden templates — pinned deps + real lockfile + fixed stack · 3df3a19 ·
  template.test.ts + CI template job
- status: fixed pending live re-verify (e2e-11)

## template.stale-pinned-deps
- first seen: 2026-07-17 · /tmp/debug-e2e-11 (the FIRST template-scaffolded build) · pomodoro-timer
- symptom: depvuln(10 blocking) on round 1 — every finding against the template's own pinned
  next@15.1.6 (middleware auth bypass, RSC pre-auth RCE, several DoS). The deterministic
  dep-bumper converged (round 2: one left), but every build was going to burn ~2 fix rounds
  re-fixing the same known-stale pins.
- root cause: the template pinned the version the author knew, not the currently CVE-clean one.
  Pinned deps trade drift for staleness — the trade is only sound if freshness is enforced.
- fix: templates re-pinned to next@15.5.20 (the maintained 15.x backport line), lockfiles
  regenerated, build+boot re-proven. Next 15.5 also changed standalone output layout under an
  inferred workspace root — pinned outputFileTracingRoot so the layout is invariant. CI's
  template job would have caught a build/boot break but NOT a CVE: freshness needs its own
  check (open idea: run the depvuln scanner against templates/ in CI).
- status: fixed (this entry's open idea tracks the missing enforcement)

## platform.node-env-starved-devdeps
- first seen: 2026-07-17 · /tmp/debug-e2e-11 rounds 2-3 · pomodoro-timer (retroactively: e2e-10's
  identical loop; e2e-9 round 2's "Cannot find namespace 'JSX'")
- symptom: clean-env verify failed "Module not found: Can't resolve '@/components/…'" on a
  workspace whose files were all present; recurred identically across fix rounds because the
  finding blamed the app ("undeclared dependency or lockfile drift") and the fixer looped on the
  wrong layer.
- root cause (reproduced in isolation on the prod box): npm's `omit` config defaults to "dev"
  whenever NODE_ENV=production is in its environment; the platform's own process runs with
  NODE_ENV=production and safeToolEnv forwarded it — every gate-spawned npm install/ci silently
  skipped typescript/tailwindcss/@types, so Next never read tsconfig paths. `npm config get
  omit` → "dev" on the box was the confirming evidence.
- fix: gate-check owns its toolchain env — NODE_ENV removed from TOOL_ENV_ALLOW +
  npm_config_include=dev pinned · 53b7eb2 · verify.test.ts
- status: fixed — then REOPENED 2026-07-18 (benchmark run 1, case pomodoro held): the class had
  more members. The FIRST install to touch a workspace (proptest generation's fast-check
  install) ran unscoped, created the starved node_modules, and installStale's mtime-only check
  then deemed it fresh forever — so the safeToolEnv fix never got a chance to run an install.
  Closed properly: every workspace npm spawn site scoped (proptest/generate, autofix/depbump,
  preview, diagnose) AND installStale now detects a starved install (any declared dep missing
  on disk → stale), which self-heals workspaces poisoned by any past or future unscoped
  installer. Locked by verify.test.ts's starved-install test.

## proptest.cross-file-global-pollution
- first seen: 2026-07-18 · /tmp/debug-e2e-12 (held esc-oijrb9) · pomodoro-timer
- symptom: proptest blocked on F2+F4 across 11 fix attempts; the fixer kept "fixing" app behavior
  that was never broken (verified: the failing counterexample ["",0] passes against the real
  lib/storage.ts in isolation).
- root cause (reproduced by pairwise runs on the box): generated property files install global
  fakes (window/localStorage); `bun test <dir>` runs all files in ONE process, so f3's leaked
  globals failed any storage property that ran after it — every file green alone, f3+anything red.
  Generation-time validation runs per-file; the gate ran per-dir — a contract mismatch inside the
  platform.
- fix: the proptest gate runs one process per test file (same assertions, same blocking; each
  finding now carries its own output tail too) · <this commit> · proptest.test.ts
- status: fixed

## platform.ship-never-reuses-backend-across-sandboxes
- first seen: 2026-07-19 · acceptance test prompt C (Supabase lunch tracker), 2nd/3rd ship
  attempts · production-wide since VIBEHARD_BUILD_WORKER=e2b went live (2026-07-11) — every
  tenant's every redeploy, not just this session's test builds
- symptom: repeated ship attempts for the SAME app each showed "provisioning backend
  (reuse=false)" and created a NEW Supabase project; eventually the org's free-tier 2-project
  cap was hit: "adamrmatar (2 project limit) ... delete, pause or upgrade."
- root cause: `cli.ts ship` is `deployApp`'s only caller and runs as a bare subprocess with no
  live DB connection — on the platform host, or (production) inside a fresh E2B sandbox.
  Without an explicit `sql`, `defaultSubstrateDeps` falls back to `FileRecordStore` under
  `~/.vibehard/deployments` — OUTSIDE the workspace directory the build-worker's checkpoint
  tars — so it never survives a sandbox teardown. Every sandboxed ship, forever, saw no prior
  record and re-provisioned from scratch: a genuine data-loss/orphaned-infrastructure bug (a
  redeploy abandons the previous backend and its data), not merely a quota nuisance.
- fix: httpRecordStore (src/substrate/record-client.ts) — a RecordStore over a new, narrow,
  tokened `/api/internal/deployment-record` endpoint (mirrors the existing checkpoint-ping
  pattern exactly: the SAME reusable dispatch token, "bad/wrong-app token → bare 404" posture,
  never a raw DB connection into the sandbox). E2BBuildWorker.dispatch injects
  VIBEHARD_PLATFORM_BASE_URL/VIBEHARD_RECORD_TOKEN; cli.ts ship constructs the client when
  present; defaultSubstrateDeps/DeployAppOptions gained a `records` override that wins over the
  sql/file fallback. Locked by tests at every seam: the HTTP client, the override wiring, the
  env injection, and the endpoint's pure scope-enforcement (authorizeRecordRequest).
- status: fixed, pending live re-verification (needs a freed Supabase project slot to re-ship C)

## platform.rls-probe-races-postgrest-schema-cache
- first seen: 2026-07-19 · acceptance test prompt C, the first ship ever to reach real backend
  provisioning (a brand-new managed Supabase project, not an adopted pre-existing one)
- symptom: "deploy aborted at verify-live-rls: live RLS NOT enforced — could not prove RLS for:
  teams, users, orders (failing closed)" — immediately after migrations applied successfully.
- root cause (confirmed by hand): migrations run over a DIRECT Postgres connection and were
  ready instantly; the live-RLS probe goes through PostgREST — a SEPARATE service that needs a
  moment to pick up brand-new tables (schema-cache reload) right after a project is created.
  Probing the SAME three tables by hand ~2 minutes later returned a clean 200+[] from all
  three — proving this was transient propagation lag, not a real security gap, and that the app
  was actually secure the whole time.
- fix: verifyLiveRls retries a genuinely INCONCLUSIVE table before recording it — a real LEAK or
  a real DENY is still conclusive on the FIRST attempt and is NEVER retried, so the fail-closed
  guarantee is unchanged, only the transient-lag false positive is removed. Locked by tests:
  retry-then-resolves, retry-exhausted-still-fails-closed, zero retries for both leak and deny.
- SECOND DATA POINT (same day) — MISDIAGNOSED: the first cut (8×5s=35s) wasn't enough for the
  very next ship, so this entry widened it to 20×10s (~190s) on a "slower cold-start" theory.
  WRONG — see platform.secrets-store-never-reuses-connection-across-sandboxes below for the
  actual cause, found after a THIRD identical failure whose RLS step took a suspiciously exact
  ~9.5 minutes (3 tables × the full 190s budget each, EVERY attempt inconclusive — a signature
  of a structurally broken probe, not a real-but-slow one). The retry widening is harmless
  (bounded, zero-cost on the happy path) but was NOT the fix; kept as a real, if smaller,
  hardening (a genuine one-time schema-cache nudge on a truly fresh project is still plausible).
- status: superseded — the retry tolerance stays; the actual root cause is the linked entry

## platform.secrets-store-never-reuses-connection-across-sandboxes
- first seen: 2026-07-19 · acceptance test prompt C, THIRD identical ship failure in a row (all
  three: "could not prove RLS for: teams, users, orders") — the actual root cause behind
  platform.rls-probe-races-postgrest-schema-cache, which had misdiagnosed the first two
- symptom: the RLS-verify step's wall-clock time was ~9.5 minutes — an exact multiple of 3 tables
  × the full ~190s retry budget each, meaning EVERY attempt on EVERY table was inconclusive,
  never once resolving early. That signature (100% failure rate, zero variance) is a structurally
  broken probe, not a slow-but-real one — a genuine propagation delay would show SOME early
  successes as things warmed up.
- root cause: the SAME non-durability defect as
  platform.ship-never-reuses-backend-across-sandboxes, one layer deeper. That fix made
  projectRef/appliedMigrations/hostRef durable via httpRecordStore — but ensureProject's REUSE
  path also needs the project's FULL CONNECTION (url/anonKey/serviceKey/dbHost/dbPassword) from
  `secretsStore`, which still defaulted to LocalEncryptedSecretsStore under `~/.vibehard/secrets`
  — gone on sandbox teardown, same as the record store before it. On reuse, `secretsStore.get()`
  returned null in the fresh sandbox, and `ensureProject` silently fell through to `this.env`'s
  EMPTY constructor default (`{url:"",anonKey:"",serviceKey:""}`) — every live-RLS probe then hit
  a URL with literally no host, for the ENTIRE retry budget, no amount of waiting could ever have
  fixed it. applyMigrations masked this: with every migration already recorded applied (via the
  WORKING record store), its `todo` list was empty, so it returned success WITHOUT ever touching
  `this.env`, hiding the broken connection until the RLS step needed it.
- fix: httpSecretsStore (secrets-client.ts) — the SAME architecture as httpRecordStore, a direct
  sibling — over a new `/api/internal/backend-secrets` endpoint, same auth posture, same
  encrypted-at-rest PgSecretsStore newly exposed instead of unused. Wired via the SAME dispatch
  token already used for records (this data is no more sensitive than what the sandbox already
  handles in-memory for its OWN app during creation). ALSO hardened the actual decision point:
  ensureProject's reuse branch now THROWS immediately if a claimed projectRef has no stored
  secrets — this is ALWAYS a genuine inconsistency, never a legitimate state, so any FUTURE
  recurrence (a real data-loss bug, a manual deletion) surfaces in seconds with an actionable
  message instead of ~10 minutes with a misleading "could not prove RLS" abort three layers away.
- status: fixed, pending live re-verification (re-ship C)

## infra.model-slug-delisted
- first seen: 2026-07-17 · /tmp/debug-e2e-10 (first attempt) · pomodoro-timer
- symptom: "Model deepseek-v3.2 is not supported" at the first LLM call (OpenCode Zen);
  OpenRouter separately out of credits.
- root cause: provider catalog changed under a pinned slug; no preflight check of the model set.
- fix: reason-lite → deepseek-v4-flash on opencode · ee2c7f6 · models.test.ts. (Open idea: a
  cheap preflight that lists the provider catalog and fails fast with a clear message.)
- status: fixed
