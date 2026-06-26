import { describe, expect, test } from "bun:test";
import { stripeConnectAuthUrl, exchangeStripeConnectCode, stripeKeychainEntries } from "./stripe-connect.ts";

describe("stripeConnectAuthUrl — the page we send the user to authorize on Stripe", () => {
  test("carries client_id, scope, state, and the registered redirect_uri", () => {
    const u = new URL(stripeConnectAuthUrl({ clientId: "ca_test123", state: "s-tok", redirectUri: "http://localhost:4100/auth/stripe/callback" }));
    expect(u.origin + u.pathname).toBe("https://connect.stripe.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("ca_test123");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("read_write");
    expect(u.searchParams.get("state")).toBe("s-tok");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:4100/auth/stripe/callback");
  });

  test("prefills the user's email/business name when known", () => {
    const u = new URL(stripeConnectAuthUrl({ clientId: "ca_x", state: "s", stripeUser: { email: "a@b.com", businessName: "Acme" } }));
    expect(u.searchParams.get("stripe_user[email]")).toBe("a@b.com");
    expect(u.searchParams.get("stripe_user[business_name]")).toBe("Acme");
  });
});

describe("exchangeStripeConnectCode — code → the connected account's tokens", () => {
  test("returns the connected account's keys on success", async () => {
    const fake = async (url: string, init?: RequestInit): Promise<Response> => {
      expect(url).toBe("https://connect.stripe.com/oauth/token");
      const body = new URLSearchParams(init!.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("ac_code");
      expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk_platform");
      return new Response(
        JSON.stringify({ stripe_user_id: "acct_123", access_token: "sk_live_connected", refresh_token: "rt_1", stripe_publishable_key: "pk_live_connected", livemode: true, scope: "read_write" }),
        { status: 200 },
      );
    };
    const t = await exchangeStripeConnectCode({ clientSecret: "sk_platform", code: "ac_code" }, fake);
    expect(t.stripeUserId).toBe("acct_123");
    expect(t.accessToken).toBe("sk_live_connected");
    expect(t.publishableKey).toBe("pk_live_connected");
    expect(t.livemode).toBe(true);
  });

  test("throws Stripe's own message when the code is already used / invalid", async () => {
    const fake = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "This authorization code has already been used." }), { status: 400 });
    await expect(exchangeStripeConnectCode({ clientSecret: "sk_platform", code: "used" }, fake)).rejects.toThrow(/already been used/);
  });

  test("throws when the response is missing the access token", async () => {
    const fake = async (): Promise<Response> => new Response(JSON.stringify({ stripe_user_id: "acct_1" }), { status: 200 });
    await expect(exchangeStripeConnectCode({ clientSecret: "sk_platform", code: "x" }, fake)).rejects.toThrow(/token exchange failed|Stripe Connect/);
  });
});

describe("stripeKeychainEntries — the encrypted values a successful connect persists", () => {
  test("maps tokens to STRIPE_* env names; omits publishable when absent", () => {
    expect(stripeKeychainEntries({ stripeUserId: "acct_9", accessToken: "sk_9", livemode: false })).toEqual({
      STRIPE_SECRET_KEY: "sk_9",
      STRIPE_ACCOUNT_ID: "acct_9",
    });
    expect(stripeKeychainEntries({ stripeUserId: "acct_9", accessToken: "sk_9", publishableKey: "pk_9", livemode: true })).toEqual({
      STRIPE_SECRET_KEY: "sk_9",
      STRIPE_ACCOUNT_ID: "acct_9",
      STRIPE_PUBLISHABLE_KEY: "pk_9",
    });
  });
});
