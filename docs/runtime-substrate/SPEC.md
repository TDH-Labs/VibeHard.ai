# Runtime Substrate — SPEC (intent)

> Stage 1 of 3 (spec → PRD → architecture). The grilled intent: *what* we're building,
> *for whom*, the scope, and the security/ownership posture. Authored as a VibeHard feature
> plan, using VibeHard's own front-half discipline. **Revised after review (v2)** — see the
> "Decisions from review" section.

## One-liner
The **last mile that turns a gated, passing app into a live, hosted app with a real
managed backend** — connect → provision → apply migration → **verify RLS is live** → inject
secrets → deploy → live URL. It turns VibeHard from a *verified-code factory* into an *app
platform*, **without VibeHard becoming the operator of everyone's data.**

## Why now (the gap it closes)
Today VibeHard produces verified, secure source code plus a `supabase/migrations/*.sql`
the gates check for RLS — but nothing provisions a database, applies that migration, or
deploys anything. `deploy` is a stub that throws. So nothing downstream works — not a
design-partner demo, not even the escalation slice (whose last step is "re-gate → deploy").
The substrate unblocks both. And the gates only *matter* on a running app; this is what
makes them matter.

## Users
- **The non-technical operator** — gets a **live URL** and a working app, after a one-time
  "connect your Supabase" step. Never writes a migration, sets an env var, or opens a
  deploy console. (Primary.)
- **The VibeHard platform** — orchestrates connect/provision/deploy deterministically.

## Decisions from review (load-bearing)
- **Customer-owned backends (DECIDED).** VibeHard provisions each app's backend **into the
  customer's OWN Supabase organization**, via an OAuth connection the customer grants once.
  VibeHard acts *on the customer's behalf* — it is the **builder/processor, never the data
  controller.** The data, the infra cost, and the data-controller liability stay with the
  customer. VibeHard never holds N customers' PHI/financial data — exactly the platform/
  compliance weight §16 says not to take on early. The one-time "connect Supabase" friction
  is, for the sensitive-data segment, a **trust feature**: *your data lives in your own
  account; we never hold it.* (The fully-bundled "we own it all" model fits hobbyists;
  it's backwards for our segment. Revisit for a broader/low-stakes market later.)
- **Walking-skeleton v1 (DECIDED).** The substrate is the *least differentiated* part of
  the product — commodity assembly of managed services. We build the **thinnest thing that
  proves "prompt → live, secure URL" end-to-end with one design partner**, behind clean
  seams, and productize only once someone's paying. **"Thin" applies to the commodity
  assembly — NOT to the safety guarantees** (the gate precondition, the live-RLS probe, and
  secret discipline are real even in the skeleton).

## In scope (v1 — the walking skeleton)
- **Connect** the customer's Supabase org (one-time OAuth).
- **Provision/reuse** one Supabase project for the app **in the customer's org** (Postgres +
  auth + storage + auto-API).
- **Apply** the gated migration(s) to that project's database.
- **Verify RLS is enforced LIVE** — fire a real anonymous query, confirm it's denied;
  **abort the deploy if not** (the differentiated step — see PRD).
- **Configure auth** (providers + redirect URLs to the deployed app).
- **Inject secrets** into the host; **anon key only** reaches the browser, **service-role
  key never** does. Stored encrypted at rest (local store v1, behind a seam).
- **Deploy the frontend** to one host → a **live URL**.
- **`vibehard destroy <app>`** — a crude teardown (delete the app's resources + clear its
  record). Needed for dogfooding hygiene + customer offboarding from day one.
- **Persist an app → resources record** for idempotent re-deploy.
- **Hand the live app to §20 prod-feedback.**

## Out of scope (v1 — captured, not now; build once there's paying demand)
- Full idempotency/rollback hardening, multi-provider impls, cloud KMS-backed secrets,
  platform-DB-backed record (v1 uses a local store).
- Custom domains, multi-region, full lifecycle teardown UI.
- Email beyond Supabase auth emails; payments (the customer's own Stripe).
- The **front-door UI** (separate work — the bolt.diy fork, §3).
- The **AI Maintainer** (separate product — `docs/ROADMAP.md`).

## Data + security posture
- **VibeHard is a processor, not a controller** (customer-owned backends). It handles the
  customer's connection secrets *transiently* to inject them — by reference where possible,
  encrypted at rest, **never logged** (§21 sanitization), via **least-privilege** OAuth
  scopes. Data classification of what VibeHard touches: **credentials** → production rigor.
- **Isolation:** each app's backend is the customer's own project — isolation by ownership,
  not just by RLS.

## Invariants (non-negotiable)
- **Runs ONLY after the gate sentinel** (`HARD_VERIFY_PASS`). A blocked app never reaches
  provisioning or deploy. (Reuses the existing deploy-gate precondition.)
- **Deterministic orchestration, ZERO LLM in the deploy path** (§11).
- **Live-RLS verified before "live"** — the differentiated guarantee carried into runtime.
- **Buy the services, build the gate-gated glue** (§3).

## Success = a non-technical operator goes from prompt to a working, secure, live URL
…in their own Supabase account, with the gated RLS **proven enforced live**, secrets handled
safely, and re-deploys that don't blow away their data — none of which they had to
understand, and none of which makes VibeHard the custodian of their data.
