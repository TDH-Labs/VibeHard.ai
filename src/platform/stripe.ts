/**
 * Stripe billing — the REAL BillingProvider behind the seam (vs LocalBillingProvider's stub).
 * StripeClient is a thin wrapper over the Stripe REST API (form-encoded bodies, Bearer secret key)
 * behind an injectable fetch seam, so the whole thing unit-tests against a fake Stripe — no account.
 *
 * HONEST LIMITS (read before wiring): this is the billing CODE; it can't charge anyone until a
 * hosted STOREFRONT exists — the Checkout success/cancel URLs and the subscription webhook live
 * there, not here. The plan a tenant is on (tenant.plan) is the source of truth for planFor, kept
 * in sync FROM Stripe by that webhook (which calls planNameForPrice). Use a TEST key (sk_test_…)
 * for everything in development — the client REFUSES a live key unless explicitly overridden.
 */
import type { BillingProvider, Plan, Tenant, UsageEvent } from "./types.ts";
import { planFor as planForName } from "./plans.ts";

const STRIPE_API = "https://api.stripe.com";

export interface StripeClientOptions {
  secretKey?: string; // STRIPE_SECRET_KEY (sk_test_… in dev — NEVER the live key)
  fetchImpl?: typeof fetch;
  apiBase?: string;
  allowLiveKey?: boolean; // explicit opt-in to use an sk_live_ key (off by default — dev safety)
}

/** Stripe wants application/x-www-form-urlencoded, not JSON. */
function form(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  return u.toString();
}

export class StripeClient {
  private readonly secretKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(opts: StripeClientOptions = {}) {
    this.secretKey = opts.secretKey ?? process.env.STRIPE_SECRET_KEY ?? "";
    if (!this.secretKey) throw new Error("StripeClient: missing STRIPE_SECRET_KEY");
    if (this.secretKey.startsWith("sk_live") && !opts.allowLiveKey) {
      throw new Error("StripeClient: refusing a LIVE key (sk_live_) in dev — use a test key (sk_test_) or pass allowLiveKey to override");
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? STRIPE_API;
  }

  get isTestMode(): boolean {
    return this.secretKey.startsWith("sk_test");
  }

  private async req(method: string, path: string, body?: Record<string, string | number | undefined>): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: body ? form(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Stripe ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  /** A Stripe customer for a tenant (the billing entity their subscription attaches to). */
  async createCustomer(input: { email: string; name?: string; tenantId?: string }): Promise<{ id: string }> {
    const j = (await this.req("POST", "/v1/customers", {
      email: input.email,
      name: input.name,
      "metadata[tenantId]": input.tenantId,
    })) as { id: string };
    return { id: j.id };
  }

  /** A subscription Checkout session — the URL the STOREFRONT sends a customer to, to subscribe.
   *  `tenantId` is stamped onto the SUBSCRIPTION's metadata so the webhook can resolve the tenant
   *  from every subscription.* event (the source-of-truth link). */
  async createCheckoutSession(input: { customerId: string; priceId: string; successUrl: string; cancelUrl: string; tenantId?: string }): Promise<{ id: string; url: string }> {
    const j = (await this.req("POST", "/v1/checkout/sessions", {
      mode: "subscription",
      customer: input.customerId,
      "line_items[0][price]": input.priceId,
      "line_items[0][quantity]": 1,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      "subscription_data[metadata][tenantId]": input.tenantId,
      allow_promotion_codes: "true", // lets a customer enter a coupon/promo code at checkout (e.g. a beta-tester discount)
    })) as { id: string; url: string };
    return { id: j.id, url: j.url };
  }

  /** The active subscription's price id (→ map to a plan via planNameForPrice), or null if none. */
  async activePriceId(customerId: string): Promise<string | null> {
    const j = (await this.req("GET", `/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=active&limit=1`)) as {
      data?: Array<{ items?: { data?: Array<{ price?: { id?: string } }> } }>;
    };
    return j.data?.[0]?.items?.data?.[0]?.price?.id ?? null;
  }
}

export interface StripeBillingOptions {
  client?: StripeClient;
  /** Stripe price id → plan name. Values MUST be real plan keys from PLANS (plans.ts): "starter" /
   *  "pro" (or "free"). The webhook uses this to sync tenant.plan; an unknown name fails closed to
   *  free (planFor), so a typo here silently downgrades paying customers — keep it aligned with PLANS. */
  priceToPlan?: Record<string, string>;
}

export class StripeBillingProvider implements BillingProvider {
  readonly name = "stripe";
  private readonly client: StripeClient;
  private readonly priceToPlan: Record<string, string>;

  constructor(opts: StripeBillingOptions = {}) {
    this.client = opts.client ?? new StripeClient();
    this.priceToPlan = opts.priceToPlan ?? {};
  }

  /** The tenant's plan, read from the tenant record — kept in sync FROM Stripe by the storefront's
   *  webhook (subscription change → planNameForPrice → update tenant.plan). planFor stays sync per the seam. */
  planFor(tenant: Tenant): Plan {
    return planForName(tenant);
  }

  /** Map a Stripe price id → the plan name to set on the tenant (the webhook's job). */
  planNameForPrice(priceId: string): string | null {
    return this.priceToPlan[priceId] ?? null;
  }

  /** Usage is already recorded durably in the platform's UsageLedger; pushing it to Stripe metered
   *  billing is opt-in and needs a configured meter, so v1 is a no-op (the ledger is the truth). */
  async recordUsage(_tenantId: string, _event: UsageEvent): Promise<void> {
    /* wire a Stripe billing-meter event here once a meter id exists on the account */
  }

  /** The client, for the customer + checkout flows the storefront drives. */
  get stripe(): StripeClient {
    return this.client;
  }
}
