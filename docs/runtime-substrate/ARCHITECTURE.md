# Runtime Substrate — ARCHITECTURE (technical design)

> Stage 3 of 3. The PRD's requirements turned into components, the seams they sit behind,
> the dependency graph that orders the build, and the v1-vs-later split. Mirrors Drydock's
> existing patterns (the `Engine` and `DeployTarget` seams; the gate sentinel precondition).

## Shape
A deterministic **orchestrator** runs a fixed sequence behind three **provider seams** and
one **state record**, gated by the existing deploy sentinel:

```
[gate chain passes → HARD_VERIFY_PASS sentinel]
        │   (the existing, unskippable precondition — §11)
        ▼
provisionAndDeploy(app)                         ← the orchestrator (ours, deterministic)
  1. load/init DeploymentRecord(app)            ← idempotency key
  2. BackendProvider.ensureProject(record)      ← Supabase project (provision once)
  3. BackendProvider.applyMigrations(record, migrations)   ← run only new ones; abort on error
  4. BackendProvider.configureAuth(record, appUrl)
  5. SecretsStore.put(app, {url, anonKey, serviceKey})     ← encrypted; serviceKey server-side only
  6. HostProvider.deploy(workspace, {env: anonKey + url})  ← build + ship frontend → URL
  7. record.url = url; record.status = "live"; persist
  8. hand off to §20 prod-feedback (point the scan at the app's logs)
```

Everything is API calls in a fixed order — **no LLM anywhere in this path** (§11). Failure
at any step leaves the record in its last good state; a re-run resumes (R8).

## Components / workstreams

- **W1 `BackendProvider` (seam) + `SupabaseProvider` (impl).** `ensureProject`,
  `applyMigrations`, `configureAuth`, returns connection secrets. Wraps the Supabase
  Management API. The seam lets a `NeonProvider` (Postgres-only) drop in later; the impl is
  the one place Supabase specifics live (parallels `defaultModelFactory`).
- **W2 `HostProvider` (seam) + one impl (e.g. `VercelHostProvider`).** `deploy(workspace,
  env) → { url }`, idempotent on the app's host project. This **generalises the existing
  `DeployTarget` seam** in `engine/deploy.ts` — that file already anticipated "a real
  connector (Netlify/Vercel/…) drops in behind `DeployTarget` later." W2 is that connector,
  plus env injection.
- **W3 `SecretsStore` (seam) + impl.** `put`/`get`/`ref` per app, encrypted at rest, backed
  by a cloud secrets manager. Enforces NFR-security: service-role key by reference, never
  logged, never in the frontend env.
- **W4 `DeploymentRecord` store.** Durable `{ app, supabaseProjectRef, hostProjectRef, url,
  appliedMigrations[], secretsRef, status }`. The idempotency + lifecycle backbone (R6).
  v1: a simple persisted store (file/SQLite); swap for the platform DB later.
- **W5 `provisionAndDeploy` orchestrator.** Sequences W1–W4 with abort/resume semantics
  (R2/R8). Pure-ish control flow over the seams → unit-testable with **fake providers**
  (the project's standard pattern: deterministic core, injected I/O).
- **W6 Wiring.** Slot the orchestrator behind the existing gated-deploy path
  (`engine/deploy.ts` → real `DeployTarget`/`provisionAndDeploy`), make `drydock deploy`
  actually deploy, and run it from `build`'s tail after a green production build (sentinel
  present). Reuses `deployGate`/the sentinel — no new precondition logic.

## Dependency graph → build order (topological tiers)

```
Tier 1 (independent foundations):  DeploymentRecord(W4) · SecretsStore(W3) · the seam
                                   interfaces (BackendProvider/HostProvider type-only)
Tier 2 (providers, parallel):      SupabaseProvider(W1) · HostProvider impl(W2)   ← need W3/W4 + seams
Tier 3:                            provisionAndDeploy orchestrator(W5)             ← needs W1–W4
Tier 4:                            wiring + CLI/build integration(W6)              ← needs W5
```

Within a tier the items are independent (parallel-eligible). This is the same
`buildOrder`-style topological plan the front-half produces for generated apps — applied
here to Drydock's own feature.

## Determinism / seam notes
- **Deterministic, no LLM** — consistent with the existing deploy path (§11). The substrate
  is orchestration, not generation.
- **Three swappable providers** (backend / host / secrets) — same seam discipline as
  `Engine` and `DeployTarget`; build ONE impl of each for v1, add alternates only on a
  concrete need (§3 / §13).
- **Idempotency is keyed on the `DeploymentRecord`**, not on probing the providers — the
  record is the single source of truth for "what already exists for this app."
- **The migration is run for the first time here.** The rls gate static-checks it; this is
  where it actually executes (AC2.2) — so `applyMigrations` owns its own success/abort, and
  the orchestrator treats a migration failure as a hard stop (app not live), not a warning.

## v1 vs later
- **v1 (minimal end-to-end "prompt → live URL"):** W4 (file/SQLite record), W3 (one secrets
  backend), W1 SupabaseProvider (ensureProject + applyMigrations + configureAuth + secrets),
  W2 one host impl, W5 orchestrator (happy path + abort-on-failure), W6 wiring. One live,
  secure app from one passing build.
- **Later:** full resume/rollback hardening (R8 edge cases), incremental-migration version
  tracking refinements, custom domains, app teardown, a second BackendProvider/HostProvider,
  and the platform-DB-backed record.

## What this does NOT include (boundaries restated)
- The **front-door UI** (the bolt.diy fork) — separate work; the substrate is the backend
  last-mile, the UI is the frontend last-mile.
- The **AI Maintainer** (separate product — `docs/ROADMAP.md`).
- Email beyond Supabase auth emails; payments; multi-region.
