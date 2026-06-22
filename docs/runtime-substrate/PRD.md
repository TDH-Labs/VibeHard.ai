# Runtime Substrate — PRD (requirements)

> Stage 2 of 3. The SPEC's intent elaborated into requirements with testable acceptance
> criteria, the NFRs, and the buy-vs-build calls. **Revised after review (v2):**
> customer-owned backends, a live-RLS verification step, crude teardown in v1, a local
> secrets store, and a provisioning-validation spike.

## Functional requirements
All are **behaviour after the gate sentinel** — the substrate never runs on a blocked build.

### R1 — Connect the customer's Supabase org (one-time)
The customer grants Drydock access to their Supabase organization via OAuth; the grant is
stored (a token reference) for that customer.
- **AC1.1** A customer can complete the connect flow and Drydock can thereafter act in
  their org with least-privilege scope.
- **AC1.2** Drydock never provisions in its *own* org — every project lives in the
  customer's org (it is the builder/processor, not the data owner).

### R2 — Provision/reuse one backend per app, in the customer's org (idempotent)
- **AC2.1** First deploy of app X creates exactly one Supabase project in the customer's
  org and records it.
- **AC2.2** A second deploy of app X reuses the recorded project — no new project, no
  dropped database.

### R3 — Apply the gated migration(s) to the live database
Run the app's migrations against the provisioned DB; track which have been applied; a
migration that errors **aborts the deploy** and surfaces the error.
- **AC3.1** Re-deploy applies only **new** migrations, never re-runs applied ones.
- **AC3.2** A migration with a runtime SQL error → deploy aborts, app **not** live, error
  surfaced. (This is the first place the migration actually *runs* — the rls gate only
  static-checks it, so this is a new, real failure surface.)

### R4 — Verify RLS is enforced LIVE (a first-class step; abort on failure)  ⭐
After the migration is applied, fire a **real anonymous query** against the provisioned DB
(using the anon key) against the tables the app uses, and confirm it is **denied**. If anon
(or a cross-tenant identity) can read rows it shouldn't, **abort the deploy — do not mark
the app live.**
- **AC4.1** An app whose migration enables proper RLS → the anon probe is denied → deploy
  proceeds.
- **AC4.2** An app whose live RLS is missing/permissive (even if the static gate somehow
  passed it) → the anon probe returns rows → **deploy aborts**, the gap is surfaced.
- *Why this is its own requirement, not an AC:* the substrate is the first place the SQL
  actually executes. A migration can pass the static `rls` gate and enforce something subtly
  different live. This probe is the **live counterpart to the gate** — it's what makes "we
  block, they warn" true in *production*, not just at static-analysis time. It is the one
  part of the substrate that is **differentiated** (Base44/Lovable provision + deploy too;
  they don't refuse to go live on a failed live-RLS check) — so it stays even in the thin v1.

### R5 — Configure auth
Set up Supabase auth for the app (providers + redirect/callback URLs at the deployed URL).
- **AC5.1** On the live app, a user can complete the sign-up + log-in flow the app defines.

### R6 — Inject secrets safely (security-critical)
Provision the connection secrets (project URL, anon key, service-role key); store them
encrypted at rest; inject them into the host's environment at deploy.
- **AC6.1** The live app connects to its own database (frontend works end-to-end).
- **AC6.2** The **service-role key never reaches the browser bundle** — only the anon key
  is exposed client-side.
- **AC6.3** **No secret appears in any log, build output, or error** (§21 sanitization).

### R7 — Deploy the frontend (idempotent)
Build and deploy the frontend to one host; return a live URL; later deploys update in place.
- **AC7.1** The returned URL serves the working app.
- **AC7.2** A re-deploy updates the **same** URL (no orphaned deployments, no new URL).

### R8 — Persist the app→resources record (lifecycle backbone)
`{ customer, supabaseProjectRef, hostProjectRef, url, appliedMigrations[], secretsRef,
status }` — the idempotency key for R2/R3/R7 and the basis for re-deploy + teardown.
- **AC8.1** The record survives across deploys; a re-deploy reads it and is idempotent.

### R9 — `drydock destroy <app>` (crude teardown — v1, NOT later)  ⭐
Delete the app's provisioned resources (the Supabase project in the customer's org + the
host deployment) and clear its record.
- **AC9.1** After destroy, the project and the deployment are gone and the record is cleared.
- *Why v1:* every deploy provisions a **real** project against a real quota and bill. Without
  teardown, dogfooding alone hits org limits + cost within a handful of test apps. This is
  hygiene, not lifecycle polish.

### R10 — Gate precondition + partial-failure recovery
Provision/deploy happen **only** after `HARD_VERIFY_PASS`; a failed step leaves the app
**recoverable** (never half-live); a re-deploy resumes from the recorded state.
- **AC10.1** A build that fails any gate never reaches provisioning or deploy.
- **AC10.2** Frontend-deploy failure *after* DB provision+migrate → app **not** marked live;
  a retry completes without re-provisioning or re-migrating. *(Full rollback hardening is
  post-v1; v1 needs only "never marked live unless every step, including R4, succeeded.")*

## Non-functional requirements (NFRs)
**Security (the substrate handles customer credentials):**
- Drydock is a **processor, not controller** (customer-owned org). Least-privilege OAuth
  scope; the service-role key is **server-side only**, never in a frontend build; **no
  secret is ever logged** (§21 applies to Drydock itself here).
- Secrets: **encrypted at rest in a local store behind the `SecretsStore` seam for v1**
  (still genuinely encrypted — these are service-role keys); a cloud KMS drops in behind the
  same seam later. (Matches v1's minimalism end-to-end — no heavier than the local record.)

**Reliability:** idempotent on the record; deterministic, zero LLM (§11); **all-or-not-live**
(marked live only when every step — including the live-RLS probe — passed).

**Isolation:** the customer's own project per app — isolation by ownership.

**Observability:** each step logged (sanitized); the deployed app emits the §20 schema.

## Buy-vs-build (§3 — assemble managed services, build the thin gate-gated glue)
- **Database + auth + storage + auto-API → BUY: Supabase**, provisioned **into the
  customer's org** (Management API + OAuth). One service ≈ most of Base44's bundled backend,
  and it's what the gates already assume.
- **Frontend hosting → BUY** (one host for v1 behind the `HostProvider` seam).
- **Secrets → encrypted-at-rest LOCAL store for v1** (cloud KMS later, same seam).
- **BUILD (ours):** the gate-gated orchestration, the **live-RLS probe** (R4), the
  app→resources record, crude teardown, and the provider seams. The glue + the live-RLS
  guarantee are the only non-commodity parts — and where the safety lives.

## Spike before building (de-risk the buy assumption)
The whole design rests on "Supabase Management API provisions a project programmatically,
in the customer's org, via OAuth." **Validate first:** provisioning latency (project
creation is *minutes*, not instant), org/plan/quota limits, the OAuth scopes required, and
whether reusing an existing customer project is viable (which also sidesteps cold-provision
latency). If provisioning is slow or capped, it bottlenecks the non-technical UX the
substrate exists to deliver — know that before W1.
