# Runtime Substrate — PRD (requirements)

> Stage 2 of 3. The SPEC's intent elaborated into concrete requirements with testable
> acceptance criteria, the non-functional requirements (security/reliability — the part
> with teeth here), and the buy-vs-build calls.

## Functional requirements

Each is **behaviour after the gate sentinel is written** — the substrate never runs on a
blocked build.

### R1 — Provision a per-app backend (idempotent)
Create a dedicated Supabase project for the app on first deploy; record it; reuse it on
every later deploy.
- **AC1.1** First deploy of app X creates exactly one Supabase project and records it.
- **AC1.2** A second deploy of app X reuses the recorded project — it does **not** create
  a new one, and does **not** drop the existing database.

### R2 — Apply the gated migration(s) to the live database
Run the app's `supabase/migrations/*.sql` against the provisioned DB; track which
migrations have been applied (incremental); a migration that errors **aborts the deploy**
(the app does not go live) and surfaces the error.
- **AC2.1** After a successful deploy, the gated RLS is **actually enforced**: an
  anonymous or cross-tenant query returns no rows it shouldn't see.
- **AC2.2** A migration with a runtime SQL error → deploy aborts, the app is **not** marked
  live, the SQL error is surfaced (this is the first place the migration actually *runs* —
  the rls gate only static-checks it, so this is a new, real failure surface).
- **AC2.3** Re-deploy applies only **new** migrations, never re-runs applied ones.

### R3 — Configure auth
Set up Supabase auth for the app: enabled providers and redirect/callback URLs pointing at
the deployed frontend URL.
- **AC3.1** On the live app, a user can complete the sign-up + log-in flow the app defines.

### R4 — Inject secrets safely (security-critical)
Provision the app's connection secrets (project URL, anon key, service-role key); store
them in a secrets manager; inject them into the host's environment at deploy.
- **AC4.1** The live app connects to its own database (frontend works end-to-end).
- **AC4.2** The **service-role key never reaches the browser bundle** — only the anon key
  is exposed client-side.
- **AC4.3** **No secret appears in any log, build output, or error** the substrate produces
  (ties to §21 sanitization).

### R5 — Deploy the frontend (idempotent)
Build and deploy the frontend to a host; return a live URL; later deploys update the same
target in place.
- **AC5.1** The returned URL serves the working app.
- **AC5.2** A re-deploy updates the **same** URL (no orphaned deployments, no new URL).

### R6 — Persist the app→resources mapping (the lifecycle record)
A durable record per app: `{ supabaseProjectRef, hostProjectRef, url, appliedMigrations[],
secretsRef, status }`. It is the idempotency key for R1/R2/R5 and the basis for re-deploy
and (later) teardown.
- **AC6.1** The record survives across deploys; a re-deploy reads it and is idempotent
  across all resources.

### R7 — Gate precondition (reuse the existing invariant)
Provisioning/deploy happen **only** after `HARD_VERIFY_PASS`.
- **AC7.1** A build that fails any gate never reaches provisioning or deploy.

### R8 — Partial-failure recovery
A step that fails leaves the app in a **recoverable** state — never half-live. A re-deploy
resumes from the recorded state.
- **AC8.1** Frontend-deploy failure *after* the DB was provisioned + migrated → the app is
  **not** marked live; a retry completes without re-provisioning or re-migrating.

## Non-functional requirements (NFRs)

**Security (this is the headline — the substrate holds customer credentials):**
- Secrets live in a **secrets manager**, encrypted at rest; the substrate handles them by
  reference, not by value, wherever possible.
- **Least-privilege** provisioning credentials (scoped tokens; not an org-admin god key).
- The **service-role key is server-side only** — never in a frontend build/env that ships
  to the browser.
- **No secret is ever logged** — the substrate is itself subject to §21 (it's a
  sensitive-credential handler).

**Reliability:**
- **Idempotent** end to end (re-deploy is safe and converges).
- **Deterministic**, zero LLM in the path (§11).
- **All-or-not-live**: an app is marked live only when every step succeeded (R8).

**Isolation:** one backend **per app** — no shared database across customers' apps.

**Observability:** each deploy step is logged (sanitized), and the deployed app emits the
§20 JSONL log schema so prod-feedback can watch it.

## Buy-vs-build (§3 — assemble managed services, build the thin glue)
- **Database + auth + storage + auto-API → BUY: Supabase** (Management API to provision a
  project). One service covers most of Base44's bundled backend, and it's exactly what the
  gates already assume.
- **Frontend hosting → BUY** (Vercel / Fly / Cloudflare Pages — pick one for v1 behind a
  seam).
- **Secrets storage → BUY** (a cloud secrets manager / KMS).
- **BUILD (ours):** the **idempotent, gate-gated orchestration** (provision → migrate →
  auth → secrets → deploy), the **app→resources record**, and the **provider seams**. This
  glue is the only part with no off-the-shelf equivalent — and it's where the safety lives.
