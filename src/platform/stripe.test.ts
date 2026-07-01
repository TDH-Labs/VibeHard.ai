import { describe, expect, test } from "bun:test";
import { StripeBillingProvider, StripeClient } from "./stripe.ts";
import type { Tenant } from "./types.ts";

type Handler = (method: string, path: string, body?: Record<string, string>) => { status?: number; json?: unknown };

function fakeStripe(handler: Handler) {
  const calls: Array<{ method: string; path: string; body?: Record<string, string>; auth?: string }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.stripe.com", "");
    const body = init?.body ? Object.fromEntries(new URLSearchParams(init.body as string)) : undefined;
    calls.push({ method, path, body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const r = handler(method, path, body);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.json ?? {}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const tenant = (plan: string): Tenant => ({ id: "t", name: "n", plan, status: "active", createdAt: "t" });

describe("StripeClient", () => {
  test("constructor: missing key throws; a live key is refused unless explicitly allowed", () => {
    expect(() => new StripeClient({ secretKey: "" })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => new StripeClient({ secretKey: "sk_live_x" })).toThrow(/refusing a LIVE key/);
    expect(() => new StripeClient({ secretKey: "sk_live_x", allowLiveKey: true })).not.toThrow();
    expect(new StripeClient({ secretKey: "sk_test_x" }).isTestMode).toBe(true);
  });

  test("customer + checkout + subscription flows: right endpoints, form-encoded body, Bearer auth", async () => {
    const { impl, calls } = fakeStripe((_m, path) => {
      if (path === "/v1/customers") return { json: { id: "cus_1" } };
      if (path === "/v1/checkout/sessions") return { json: { id: "cs_1", url: "https://checkout.stripe.com/x" } };
      if (path.startsWith("/v1/subscriptions")) return { json: { data: [{ items: { data: [{ price: { id: "price_practice" } }] } }] } };
      return { status: 404, json: { error: "nf" } };
    });
    const c = new StripeClient({ secretKey: "sk_test_x", fetchImpl: impl });

    expect((await c.createCustomer({ email: "a@b.com", tenantId: "t1" })).id).toBe("cus_1");
    const session = await c.createCheckoutSession({ customerId: "cus_1", priceId: "price_practice", successUrl: "https://vibehard.ai/ok", cancelUrl: "https://vibehard.ai/no" });
    expect(session.url).toBe("https://checkout.stripe.com/x");
    expect(await c.activePriceId("cus_1")).toBe("price_practice");

    const checkout = calls.find((x) => x.path === "/v1/checkout/sessions");
    expect(checkout?.body?.["line_items[0][price]"]).toBe("price_practice"); // form-encoded params landed
    expect(checkout?.body?.mode).toBe("subscription");
    expect(checkout?.body?.allow_promotion_codes).toBe("true"); // lets a customer enter a coupon/promo code (beta-tester discounts)
    expect(calls.every((x) => x.auth === "Bearer sk_test_x")).toBe(true); // key in the header, never the path
    expect(calls.every((x) => !x.path.includes("sk_test_x"))).toBe(true);
  });

  test("activePriceId → null when there is no active subscription", async () => {
    const { impl } = fakeStripe(() => ({ json: { data: [] } }));
    expect(await new StripeClient({ secretKey: "sk_test_x", fetchImpl: impl }).activePriceId("cus_1")).toBeNull();
  });
});

describe("StripeBillingProvider", () => {
  test("planFor reads the tenant's (webhook-synced) plan; planNameForPrice maps; recordUsage is a no-op", async () => {
    const client = new StripeClient({ secretKey: "sk_test_x", fetchImpl: (async () => ({ ok: true, status: 200, text: async () => "{}" })) as unknown as typeof fetch });
    const provider = new StripeBillingProvider({ client, priceToPlan: { price_practice: "practice" } });

    expect(provider.planFor(tenant("free")).name).toBe("free");
    expect(provider.planNameForPrice("price_practice")).toBe("practice");
    expect(provider.planNameForPrice("price_unknown")).toBeNull();
    await provider.recordUsage("t1", { kind: "build", at: "t" }); // resolves, no throw
  });
});
