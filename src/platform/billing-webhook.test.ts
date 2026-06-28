import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { applyBillingDecision, type BillingDecision, type BillingEvent, type BillingOps, decideBillingEvent, parseStripeEvent, verifyStripeSignature } from "./billing-webhook.ts";

const SECRET = "whsec_test_abc";
function sign(payload: string, t: number, secret = SECRET): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("verifyStripeSignature", () => {
  const now = 1_700_000_000;
  const payload = '{"hello":"world"}';

  test("accepts a fresh, correctly-signed payload", () => {
    expect(verifyStripeSignature(payload, sign(payload, now), SECRET, now)).toBe(true);
  });
  test("rejects a tampered payload", () => {
    expect(verifyStripeSignature(payload + "x", sign(payload, now), SECRET, now)).toBe(false);
  });
  test("rejects a stale timestamp (replay window)", () => {
    expect(verifyStripeSignature(payload, sign(payload, now - 10_000), SECRET, now)).toBe(false);
  });
  test("rejects a wrong secret", () => {
    expect(verifyStripeSignature(payload, sign(payload, now, "whsec_other"), SECRET, now)).toBe(false);
  });
  test("rejects empty secret / header / payload", () => {
    expect(verifyStripeSignature(payload, sign(payload, now), "", now)).toBe(false);
    expect(verifyStripeSignature(payload, "", SECRET, now)).toBe(false);
    expect(verifyStripeSignature("", sign(payload, now), SECRET, now)).toBe(false);
  });
  test("rejects a malformed header (no v1)", () => {
    expect(verifyStripeSignature(payload, `t=${now}`, SECRET, now)).toBe(false);
  });
  test("accepts when ANY of multiple v1 signatures matches (key rotation)", () => {
    const good = createHmac("sha256", SECRET).update(`${now}.${payload}`).digest("hex");
    expect(verifyStripeSignature(payload, `t=${now},v1=deadbeef,v1=${good}`, SECRET, now)).toBe(true);
  });
});

describe("parseStripeEvent", () => {
  test("extracts id, type, tenantId, status, priceId from a subscription event", () => {
    const e = parseStripeEvent({
      id: "evt_123",
      type: "customer.subscription.updated",
      data: { object: { status: "active", metadata: { tenantId: "t_42" }, items: { data: [{ price: { id: "price_pro" } }] } } },
    });
    expect(e).toEqual({ id: "evt_123", type: "customer.subscription.updated", tenantId: "t_42", status: "active", priceId: "price_pro" });
  });
  test("never throws on garbage; missing fields → null", () => {
    expect(parseStripeEvent(null)).toEqual({ id: null, type: "", tenantId: null, status: null, priceId: null });
    expect(parseStripeEvent({ type: "x", data: { object: { metadata: {} } } })).toEqual({ id: null, type: "x", tenantId: null, status: null, priceId: null });
  });
});

describe("decideBillingEvent", () => {
  const map = { price_pro: "pro", price_starter: "starter" };
  const ev = (over: Partial<BillingEvent>): BillingEvent => ({ id: "evt_1", type: "customer.subscription.updated", tenantId: "t1", status: "active", priceId: "price_pro", ...over });

  test("active + mapped price → set-plan", () => {
    expect(decideBillingEvent(ev({}), map)).toEqual({ action: "set-plan", tenantId: "t1", plan: "pro" });
  });
  test("active + UNMAPPED price → ignore (never guesses a plan)", () => {
    expect(decideBillingEvent(ev({ priceId: "price_forged" }), map)).toMatchObject({ action: "ignore" });
  });
  test("past_due → suspend; unpaid → suspend", () => {
    expect(decideBillingEvent(ev({ status: "past_due" }), map)).toEqual({ action: "suspend", tenantId: "t1" });
    expect(decideBillingEvent(ev({ status: "unpaid" }), map)).toEqual({ action: "suspend", tenantId: "t1" });
  });
  test("canceled / deleted → downgrade-free", () => {
    expect(decideBillingEvent(ev({ status: "canceled" }), map)).toEqual({ action: "downgrade-free", tenantId: "t1" });
    expect(decideBillingEvent(ev({ type: "customer.subscription.deleted" }), map)).toEqual({ action: "downgrade-free", tenantId: "t1" });
  });
  test("no tenantId → ignore; unknown status → ignore; unknown type → ignore", () => {
    expect(decideBillingEvent(ev({ tenantId: null }), map)).toMatchObject({ action: "ignore" });
    expect(decideBillingEvent(ev({ status: "incomplete" }), map)).toMatchObject({ action: "ignore" });
    expect(decideBillingEvent(ev({ type: "invoice.paid" }), map)).toMatchObject({ action: "ignore" });
  });
});

describe("applyBillingDecision", () => {
  function spyOps(): BillingOps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      setPlan: (id, plan) => void calls.push(`setPlan(${id},${plan})`),
      suspend: (id) => void calls.push(`suspend(${id})`),
      resume: (id) => void calls.push(`resume(${id})`),
    };
  }
  test("set-plan sets the plan AND resumes", async () => {
    const ops = spyOps();
    await applyBillingDecision({ action: "set-plan", tenantId: "t1", plan: "pro" }, ops);
    expect(ops.calls).toEqual(["setPlan(t1,pro)", "resume(t1)"]);
  });
  test("suspend only suspends", async () => {
    const ops = spyOps();
    await applyBillingDecision({ action: "suspend", tenantId: "t1" }, ops);
    expect(ops.calls).toEqual(["suspend(t1)"]);
  });
  test("downgrade-free sets free AND resumes", async () => {
    const ops = spyOps();
    await applyBillingDecision({ action: "downgrade-free", tenantId: "t1" }, ops);
    expect(ops.calls).toEqual(["setPlan(t1,free)", "resume(t1)"]);
  });
  test("ignore touches nothing", async () => {
    const ops = spyOps();
    const out = await applyBillingDecision({ action: "ignore", reason: "x" } as BillingDecision, ops);
    expect(ops.calls).toEqual([]);
    expect(out).toContain("ignored");
  });
});
