/**
 * Stripe subscription webhook → tenant lifecycle (backlog #5). The keystone that keeps
 * `tenant.plan`/`tenant.status` in sync with the customer's Stripe subscription.
 *
 * SECURITY (§11, fail-closed): the webhook is UNTRUSTED input that grants paid plans — a forged
 * event must NEVER change a tenant's plan. `verifyStripeSignature` is the gate (HMAC-SHA256 over
 * the RAW body, constant-time, timestamp-bounded); nothing is applied unless it passes. The
 * reducer never GUESSES a plan: an unmapped/forged price → ignore, not an upgrade.
 *
 * All four functions are pure over plain data (the apply step takes an injected ops seam), so the
 * whole flow unit-tests without Stripe, a web server, or a platform.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify Stripe's `Stripe-Signature: t=…,v1=…` scheme over the EXACT raw body. Returns true only
 *  for a fresh, correctly-signed payload. Empty secret/header, stale timestamp, or any mismatch → false. */
export function verifyStripeSignature(payload: string, header: string, secret: string, nowSec: number, toleranceSec = 300): boolean {
  if (!payload || !header || !secret) return false;
  let t = 0;
  const v1s: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") v1s.push(v);
  }
  if (!t || !Number.isFinite(t) || !v1s.length) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false; // replay-window bound
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  // Stripe may send several v1 signatures (key rotation); accept if ANY matches, constant-time each.
  return v1s.some((v1) => {
    if (v1.length !== expected.length) return false;
    try {
      return timingSafeEqual(expectedBuf, Buffer.from(v1, "utf8"));
    } catch {
      return false;
    }
  });
}

/** The few fields we act on, extracted defensively from an untrusted Stripe event. Never throws. */
export interface BillingEvent {
  id: string | null; // Stripe event id (evt_…) — for replay/idempotency dedup
  type: string;
  tenantId: string | null; // from the object's metadata.tenantId (set at checkout)
  status: string | null; // subscription status
  priceId: string | null; // the subscribed price (→ plan via priceToPlan)
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function parseStripeEvent(body: unknown): BillingEvent {
  const root = obj(body);
  const object = obj(obj(root.data).object);
  const metadata = obj(object.metadata);
  const items = obj(object.items).data;
  const firstItem = Array.isArray(items) ? obj(items[0]) : {};
  const price = obj(firstItem.price);
  return {
    id: str(root.id),
    type: str(root.type) ?? "",
    tenantId: str(metadata.tenantId),
    status: str(object.status),
    priceId: str(price.id),
  };
}

export type BillingDecision =
  | { action: "set-plan"; tenantId: string; plan: string }
  | { action: "suspend"; tenantId: string }
  | { action: "downgrade-free"; tenantId: string }
  | { action: "ignore"; reason: string };

const ACTIVE = new Set(["active", "trialing"]);
const DELINQUENT = new Set(["past_due", "unpaid"]);
const ENDED = new Set(["canceled", "incomplete_expired"]);

/** Pure reducer: an untrusted (but already signature-VERIFIED) event → a lifecycle action.
 *  Fail-closed on ambiguity: no tenant, no mapped plan, or an unknown status → ignore, never an upgrade. */
export function decideBillingEvent(e: BillingEvent, priceToPlan: Record<string, string>): BillingDecision {
  if (!e.tenantId) return { action: "ignore", reason: "no tenantId in event metadata" };
  if (e.type === "customer.subscription.deleted") return { action: "downgrade-free", tenantId: e.tenantId };
  if (e.type === "customer.subscription.created" || e.type === "customer.subscription.updated") {
    if (e.status && DELINQUENT.has(e.status)) return { action: "suspend", tenantId: e.tenantId };
    if (e.status && ENDED.has(e.status)) return { action: "downgrade-free", tenantId: e.tenantId };
    if (e.status && ACTIVE.has(e.status)) {
      const plan = e.priceId ? priceToPlan[e.priceId] : undefined;
      if (!plan) return { action: "ignore", reason: `no plan mapped for price ${e.priceId ?? "(none)"} — refusing to guess` };
      return { action: "set-plan", tenantId: e.tenantId, plan };
    }
    return { action: "ignore", reason: `unhandled subscription status ${e.status ?? "(none)"}` };
  }
  return { action: "ignore", reason: `unhandled event type ${e.type || "(none)"}` };
}

/** The platform mutations the webhook needs (injected → testable; matches Platform's surface). */
export interface BillingOps {
  setPlan(tenantId: string, plan: string): void;
  suspend(tenantId: string): void;
  resume(tenantId: string): void;
}

/** Apply a decision. Returns a one-line audit string. set-plan/downgrade also RESUME (a paid-up or
 *  free tenant must not stay suspended from a prior delinquency). */
export function applyBillingDecision(d: BillingDecision, ops: BillingOps): string {
  switch (d.action) {
    case "set-plan":
      ops.setPlan(d.tenantId, d.plan);
      ops.resume(d.tenantId);
      return `tenant ${d.tenantId} → plan ${d.plan} (active)`;
    case "suspend":
      ops.suspend(d.tenantId);
      return `tenant ${d.tenantId} suspended (payment issue)`;
    case "downgrade-free":
      ops.setPlan(d.tenantId, "free");
      ops.resume(d.tenantId);
      return `tenant ${d.tenantId} → free (subscription ended)`;
    case "ignore":
      return `ignored: ${d.reason}`;
  }
}
