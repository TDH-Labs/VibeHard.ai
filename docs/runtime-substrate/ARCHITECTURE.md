# Runtime Substrate — ARCHITECTURE (technical design)

> Stage 3 of 3. The PRD's requirements turned into components, the seams they sit behind,
> the dependency graph that orders the build, and the v1-vs-later split. Mirrors Drydock's
> existing patterns (the `Engine`/`DeployTarget` seams; the gate sentinel precondition).
> **Revised after review (v2):** customer-owned provisioning, a live-RLS probe step, crude
> teardown in v1, a local secrets store, a de-risking spike, and a walking-skeleton v1.

## Shape
A deterministic **orchestrator** runs a fixed sequence behind three **provider seams** and
one **state record**, all in the *customer's* Supabase org, gated by the existing sentinel:

```
[gate chain passes → HARD_VERIFY_PASS sentinel]      ← existing, unskippable (§11)
        ▼
provisionAndDeploy(app, customer)                    ← orchestrator (ours, deterministic)
  1. load/init DeploymentRecord(app)                 ← idempotency key
  2. BackendProvider.ensureProject(record, customerOrg)   ← provision/reuse in CUSTOMER's org
  3. BackendProvider.applyMigrations(record, migrations)  ← only new ones; abort on error
  4. BackendProvider.verifyLiveRls(record, app.tables)  ⭐ ← fire a real ANON query; ABORT if not denied
  5. BackendProvider.configureAuth(record, appUrl)
  6. SecretsStore.put(app, {url, anonKey, serviceKey})    ← encrypted at rest; serviceKey server-side only
  7. HostProvider.deploy(workspace, {env: url + anonKey})  ← build + ship frontend → URL
  8. record.url = url; record.status = "live"; persist    ← only reached if 1–7 all passed
  9. hand off to §20 prod-feedback

destroy(app, customer)                               ← crude teardown (v1)
  → BackendProvider.deleteProject + HostProvider.teardown + record.clear
```

Fixed-order API calls — **no LLM anywhere** (§11). **Step 4 (live-RLS) is the differentiated
one** and a hard gate: a deploy is never marked live if the anon probe isn't denied — the
gate guarantee carried into runtime. Failure at any step leaves the record in its last good
state; a re-run resumes (R10).

## Components / workstreams

- **W1 `BackendProvider` (seam) + `SupabaseProvider` (impl).** `connect` (customer OAuth →
  org token), `ensureProject` (provision/reuse in the **customer's** org), `applyMigrations`,
  **`verifyLiveRls`** (anon-query probe), `configureAuth`, `deleteProject`; returns
  connection secrets. Wraps the Supabase Management API + OAuth. Seam lets a `NeonProvider`
  drop in later; impl is the one place Supabase specifics live (parallels `defaultModelFactory`).
- **W2 `HostProvider` (seam) + one impl.** `deploy(workspace, env) → {url}`, `teardown`,
  idempotent on the app's host project + env injection. **Generalises the existing
  `DeployTarget` seam** in `engine/deploy.ts` (which already anticipated "a real connector …
  drops in behind `DeployTarget` later").
- **W3 `SecretsStore` (seam) + LOCAL encrypted impl (v1).** `put`/`get`/`ref` per app,
  encrypted at rest. Enforces the security NFR: service-role key by reference, never logged,
  never in the frontend env. Cloud KMS impl later, same seam.
- **W4 `DeploymentRecord` store.** Durable `{ customer, supabaseProjectRef, hostProjectRef,
  url, appliedMigrations[], secretsRef, status }`. v1: a simple local persisted store
  (file/SQLite); platform DB later.
- **W5 `provisionAndDeploy` orchestrator + `verifyLiveRls` + `destroy`.** Sequences W1–W4
  with abort-on-failure + "never live unless all steps (incl. step 4) passed" (R10), plus
  crude teardown (R9). Pure-ish control flow over the seams → unit-testable with **fake
  providers** (the project's standard pattern).
- **W6 Wiring.** Slot the orchestrator behind the gated-deploy path (`engine/deploy.ts`),
  make `drydock deploy` real + add `drydock destroy`, and run provisionAndDeploy from
  `build`'s tail after a green build (sentinel present). Reuses `deployGate`/the sentinel.

## Dependency graph → build order (topological tiers)

```
Tier 0 (SPIKE, before any build):  validate Supabase Management API + OAuth — provisioning
                                   latency (minutes), org/plan/quota limits, OAuth scopes,
                                   reuse-existing-project viability. De-risk the buy assumption.
Tier 1 (independent foundations):  DeploymentRecord(W4) · SecretsStore local(W3) · seam
                                   interfaces (BackendProvider/HostProvider type-only)
Tier 2 (providers, parallel):      SupabaseProvider(W1, incl. verifyLiveRls + connect) ·
                                   HostProvider impl(W2)
Tier 3:                            provisionAndDeploy + verifyLiveRls + destroy (W5)
Tier 4:                            wiring + CLI/build integration (W6)
```

Same `buildOrder`-style topological plan the front-half produces for generated apps —
applied to Drydock's own feature.

## v1 = the WALKING SKELETON (the discipline that came out of review)
The substrate is the **least differentiated** layer — commodity assembly. v1 builds the
**thinnest end-to-end "prompt → live, secure URL" with ONE design partner**, and nothing
more, behind clean seams:

- **In v1:** the seam *interfaces* (cheap, right) + **single happy-path impls**; customer
  Supabase connect (OAuth) → provision/reuse one project → apply migration → **live-RLS
  probe (abort on fail)** → configure auth → local-encrypted secrets → deploy to one host →
  URL; **crude `drydock destroy`**; local record; gate-gated; zero-LLM. Hand-provision /
  manual steps are acceptable where cheaper *behind the seams*.
- **"Thin" applies to the COMMODITY assembly, NOT the safety guarantees.** The gate
  precondition, the **live-RLS probe**, and the secret discipline are real even in the
  skeleton — those are the differentiated, non-negotiable parts.
- **Deferred until paying demand:** full idempotency/rollback hardening (R10 edge cases),
  a second BackendProvider/HostProvider, cloud-KMS secrets, the platform-DB-backed record,
  custom domains, multi-region, full-lifecycle teardown.

## Determinism / seam notes
- **Deterministic, no LLM** — consistent with the existing deploy path (§11).
- **Three swappable providers** (backend/host/secrets) — same seam discipline as `Engine`/
  `DeployTarget`; ONE impl each for v1, alternates only on concrete need (§3 / §13).
- **Customer-owned:** every project is provisioned in the *customer's* org via their OAuth
  grant — Drydock is the processor, never the controller (§16; SPEC "Decisions from review").
- **Idempotency is keyed on the `DeploymentRecord`**, not on probing providers.
- **The migration runs for the first time here**, and **step 4 proves RLS is live** — so the
  orchestrator treats a migration error (R3) or a failed live-RLS probe (R4) as a hard stop
  (app not live), never a warning.

## What this does NOT include (boundaries restated)
- The **front-door UI** (the bolt.diy fork) — separate work; this is the backend last-mile.
- The **AI Maintainer** (separate product — `docs/ROADMAP.md`).
- Email beyond Supabase auth emails; payments; multi-region; Drydock-owned hosting of
  customer data (explicitly rejected — customer-owned, per the SPEC decision).
