# Billing & Hosting — operator setup (backlog #5)

Backlog #5 (billing · build sandbox · public hosting) is partly **code** (done,
below) and partly **operator config** of external services (this doc). The code
fails closed: nothing is enabled until you set the env vars, so an unconfigured
deploy is safe.

## 1. Billing (Stripe) — CODE DONE, needs operator config

**What's built:** `StripeClient` + `StripeBillingProvider` (src/platform/stripe.ts),
the signed webhook → tenant-lifecycle reducer (src/platform/billing-webhook.ts),
and the web endpoints `/api/billing/checkout` + `/api/billing/webhook`
(web/server.ts). `tenant.plan` is the source of truth, synced FROM Stripe BY the
webhook. Unmapped prices and forged/replayed events are rejected (fail-closed).

**Operator steps:**
1. In Stripe (TEST mode first), create a Product + recurring Price for each paid
   plan. Plans live in `src/platform/plans.ts` — today: `starter`, `pro`.
2. Set env on the web host:
   - `STRIPE_SECRET_KEY=sk_test_…` (the client REFUSES `sk_live_` unless overridden).
   - `STRIPE_WEBHOOK_SECRET=whsec_…` (from the webhook endpoint you create next).
   - `DRYDOCK_STRIPE_PRICE_MAP={"price_abc":"starter","price_def":"pro"}` — map each
     Stripe price id to a **real plan key from PLANS**. A typo here fails closed to
     `free` (silently downgrades), so keep it aligned with plans.ts.
3. In Stripe → Developers → Webhooks, add an endpoint `https://<your-host>/api/billing/webhook`
   subscribed to `customer.subscription.created|updated|deleted`. Copy its signing
   secret into `STRIPE_WEBHOOK_SECRET`.
4. Test locally with the Stripe CLI: `stripe listen --forward-to localhost:PORT/api/billing/webhook`
   then `stripe trigger customer.subscription.updated`.
5. Go live: swap to `sk_live_`/live price ids only after the test flow is verified.

## 2. Public hosting — CODE DONE (Supabase + Vercel/Fly), needs tokens + DNS

**What's built:** `drydock ship <dir>` gates → provisions a backend (Supabase,
managed or adopt) → deploys to Vercel (or Fly if a Dockerfile is present) → live
URL. See src/substrate/.

**Operator steps:**
- Backend: `SUPABASE_JWT_SECRET` (required; RLS in every deployed app). For adopt
  mode also `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; managed mode
  (`DRYDOCK_MANAGED=1`, forced for tenant deploys) auto-provisions per app.
- Host: `VERCEL_TOKEN` (+ `VERCEL_SCOPE` for a team) OR `FLY_API_TOKEN`
  (+ optional `FLY_ORG`/`FLY_REGION`).
- Secrets: set `DRYDOCK_SECRETS_KEY` to a real key (the default is a dev placeholder).
- **DNS (operator):** apps get a Vercel/Fly subdomain by default. Custom domains
  are a post-deploy step in the Vercel/Fly dashboard (add domain + CNAME).
- **OAuth apps (operator):** the storefront's Google/GitHub sign-in needs OAuth
  apps registered with the deployed callback URLs (`GOOGLE_CLIENT_ID/SECRET`,
  `GITHUB_CLIENT_ID/SECRET`). Generated apps that need their own social login need
  their own apps (or a shared operator app) — not auto-provisioned.

## 3. Build sandbox — REMAINING INFRA (not yet built)

Today builds run as a child process on the host (web/server.ts honest-limits
note). Production hardening = run each tenant's codegen/verify in an isolated,
resource-capped, network-egress-restricted container (the engine is already
`dispose()`-able / ephemeral-friendly, so this swaps in behind the build runner
seam). This is infra work (container runtime + orchestration), tracked as the
remaining item of backlog #5 — the billing + hosting code above does not depend
on it.
