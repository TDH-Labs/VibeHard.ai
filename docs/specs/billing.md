# Spec: billing (backlog #5 — billing · sandbox · hosting)

## Scope of THIS increment
Backlog #5 is mostly external (Stripe products/prices, DNS, OAuth apps, sandbox
infra). The Stripe CLIENT + provider already exist and are tested
(src/platform/stripe.ts); hosting largely exists (`drydock ship` → Supabase +
Vercel/Fly). The keystone MISSING piece is the **subscription webhook → tenant
lifecycle** sync, and it's security-critical: an unsigned/forged webhook could
hand any tenant a paid plan (privilege escalation). That's what this increment
builds. Sandbox + DNS/OAuth are documented as operator setup (BILLING_AND_HOSTING_SETUP.md).

## Goal
A verified Stripe webhook keeps `tenant.plan`/`tenant.status` in sync with the
customer's subscription: subscribe/upgrade → set plan + active; payment fails →
suspend; subscription ends → downgrade to free.

## Acceptance criteria
1. `verifyStripeSignature(payload, header, secret, now)` validates Stripe's
   `t=…,v1=…` HMAC-SHA256 scheme over the RAW body, constant-time, with a
   timestamp tolerance (default 300s). A bad/expired/missing signature → false.
   This is the gate: an unverified webhook is NEVER applied.
2. `parseStripeEvent(body)` extracts {type, tenantId (from object metadata),
   status, priceId} defensively from untrusted JSON (never throws).
3. `decideBillingEvent(event, priceToPlan)` is a pure reducer →
   set-plan | suspend | downgrade-free | ignore:
   - subscription.created/updated, status active/trialing → set-plan(mapped) (or
     ignore if the price maps to no plan — never guess a plan);
   - status past_due/unpaid → suspend;
   - status canceled/incomplete_expired, or subscription.deleted → downgrade-free;
   - no tenantId → ignore; unhandled type/status → ignore (with a reason).
4. `applyBillingDecision(decision, ops)` applies via the platform's
   setPlan/suspend/resume (injected ops → testable).
5. Web: `POST /api/billing/webhook` verifies → parses → decides → applies; a bad
   signature returns 400, everything else 200 (so Stripe doesn't retry-storm an
   ignored event). `POST /api/billing/checkout` (authed) returns a Checkout URL.
   Both are no-ops unless STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET are set.

## Out of scope (external / later)
- Creating the Stripe products/prices + the price→plan map (operator; documented).
- Metered usage → Stripe meters (the ledger is already the truth; stub stays).
- Build sandbox (container isolation) — infra; the contract is documented.
- Custom DNS + per-app OAuth apps — operator config; documented.

## Design
- `src/platform/billing-webhook.ts`: verifyStripeSignature, parseStripeEvent
  (pure, total), decideBillingEvent (pure reducer), applyBillingDecision (+ a
  BillingOps seam). No web/Stripe-SDK coupling — pure functions over data.
- stripe.ts: createCheckoutSession gains an optional `tenantId` → sets
  subscription metadata so the webhook can resolve the tenant (additive).
- web/server.ts: the two endpoints, env-gated; StripeBillingProvider wired when
  STRIPE_SECRET_KEY is present.

## Verify
- tsc clean; full suite green.
- Unit: signature valid/invalid/expired/malformed; parse (well-formed,
  garbage, missing fields); decide (every branch incl. unmapped price →
  ignore, not a guess); apply (each action calls the right ops).

## Adversarial review
- Fresh-context attack on: signature bypass (forge a v1, timing, empty secret,
  multiple v1s, body mismatch), the decide reducer (can an unmapped/forged
  price escalate a plan? can a missing status default to active?), and the
  endpoint (does an unverified body ever reach apply? is the raw body used for
  verification, not a re-serialized one?).
