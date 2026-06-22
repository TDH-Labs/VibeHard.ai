# Runtime Substrate — SPEC (intent)

> Stage 1 of 3 (spec → PRD → architecture). The grilled intent: *what* we're building,
> *for whom*, the scope, and the security posture. Authored as a Drydock feature plan,
> using Drydock's own front-half discipline.

## One-liner
The **last mile that turns a gated, passing app into a live, hosted app with a real
managed backend** — provision → apply migration → configure auth → inject secrets →
deploy → live URL. It turns Drydock from a *verified-code factory* into an *app platform*.

## Why now (the gap it closes)
Today Drydock produces verified, secure source code plus a `supabase/migrations/*.sql`
the gates check for RLS — but nothing provisions a database, applies that migration, or
deploys anything. `deploy` is a stub that throws. For our **non-technical** operator,
"here's secure code; now provision Postgres, set five env vars, and deploy to a host" is
impossible — and it's exactly the friction Base44 removed with a bundled backend. The
gates only *matter* on a running app; this is what makes them matter.

## Users
- **The non-technical operator** — gets a **live URL** and a working app. Never sees
  Postgres, env vars, or a deploy console. (Primary.)
- **The Drydock platform** — orchestrates provisioning/deploy deterministically.

## In scope (v1)
- Provision a **per-app Supabase project** (Postgres + auth + storage + auto-API in one).
- **Apply** the gated migration(s) to that project's database (RLS becomes enforced).
- **Configure auth** (providers + redirect URLs to the deployed app).
- **Inject real secrets** into the frontend host; the **anon key only** reaches the
  browser, the **service-role key never does**.
- **Deploy the frontend** to a host → a **live URL**.
- **Persist an app → resources mapping** so re-deploys are **idempotent** (reuse the same
  project/host, apply migrations incrementally), not a fresh stack each time.
- **Hand the live app to §20 prod-feedback** (point the scan at its logs).

## Out of scope (v1 — captured, not now)
- Custom domains, multi-region, app teardown UI.
- Email beyond Supabase's built-in auth emails; payments setup (the user's own Stripe).
- The **front-door UI** (separate work — the bolt.diy fork, §3).
- The **AI Maintainer** (separate product — `docs/ROADMAP.md`).

## Data + security posture (this drives the rigor — it's the crux)
- **The substrate handles customer backend CREDENTIALS** (Supabase service-role keys,
  provisioning tokens). Data classification: **credentials + (indirectly) all the app's
  data**. → **Production rigor, always.** Drydock here is subject to the very §21 controls
  it enforces on others: secrets in a manager, **never logged** (§21 sanitization),
  least-privilege provisioning creds, access-controlled.
- **Tenancy: per-app isolated backend.** Each app gets its *own* Supabase project — no
  shared database across customers' apps. Isolation by construction, not by RLS alone.

## Invariants (non-negotiable)
- **Runs ONLY after the gate sentinel** (`HARD_VERIFY_PASS`). A blocked app never reaches
  provisioning or deploy. (Reuses the existing deploy-gate precondition.)
- **Deterministic orchestration, ZERO LLM in the deploy path** (§11). Provisioning and
  deploy are fixed sequences of managed-service API calls — no model decides anything here.
- **Buy the services, build the glue** (§3): buy Supabase + a host + a secrets manager;
  build only the idempotent, gate-gated orchestration + the resource mapping (the part
  that's ours).

## Success = a non-technical operator goes from prompt to a working, secure, live URL
…with the database provisioned, the gated RLS actually enforced, secrets handled safely,
and re-deploys that don't blow away their data — none of which they had to understand.
