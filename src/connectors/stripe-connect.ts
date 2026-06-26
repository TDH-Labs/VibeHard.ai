/**
 * "Connect Stripe" — real Stripe Connect (Standard) OAuth. Unlike a pasted secret key, the user
 * clicks Connect, authorizes on Stripe's own page, and Stripe hands US the connected account's keys.
 * The non-technical user never copies a secret.
 *
 * Flow (mirrors the Google/GitHub social-login flow in web/server.ts):
 *   1. redirect the user to {authUrl}?client_id=ca_…&scope=read_write&state=… (CSRF state);
 *   2. Stripe redirects back with ?code=…&state=…;
 *   3. we POST the code + the PLATFORM secret key to the token endpoint and get back
 *      { stripe_user_id: acct_…, access_token: sk_… (the connected account's secret key),
 *        refresh_token, stripe_publishable_key: pk_…, livemode }.
 *   4. those become the app's STRIPE_* keychain entries — any built app that needs Stripe gets them
 *      injected, scoped to the user's own account.
 *
 * Pure + fetch-injected; the access_token is a live secret and is NEVER logged (§16/§21).
 */

const AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";
const TOKEN_URL = "https://connect.stripe.com/oauth/token";

export interface StripeConnectAuthOptions {
  /** the platform's Connect client id, "ca_…" (from Dashboard → Settings → Connect) */
  clientId: string;
  /** opaque CSRF token echoed back on the callback */
  state: string;
  /** "read_write" (default) lets built apps create charges; "read_only" for reporting only */
  scope?: "read_write" | "read_only";
  /** must exactly match a redirect URI registered on the Connect application */
  redirectUri?: string;
  /** prefill the connect form with what we know about the user (optional, all best-effort) */
  stripeUser?: { email?: string; businessName?: string };
}

/** Build the URL to send the user to so they can authorize the connection on Stripe. */
export function stripeConnectAuthUrl(opts: StripeConnectAuthOptions): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("scope", opts.scope ?? "read_write");
  u.searchParams.set("state", opts.state);
  if (opts.redirectUri) u.searchParams.set("redirect_uri", opts.redirectUri);
  if (opts.stripeUser?.email) u.searchParams.set("stripe_user[email]", opts.stripeUser.email);
  if (opts.stripeUser?.businessName) u.searchParams.set("stripe_user[business_name]", opts.stripeUser.businessName);
  return u.toString();
}

export interface StripeConnectTokens {
  stripeUserId: string; // acct_…
  accessToken: string; // sk_… — the connected account's secret key
  refreshToken?: string;
  publishableKey?: string; // pk_…
  livemode: boolean;
  scope?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface TokenError {
  error: string;
  error_description?: string;
}
interface TokenSuccess {
  stripe_user_id: string;
  access_token: string;
  refresh_token?: string;
  stripe_publishable_key?: string;
  livemode?: boolean;
  scope?: string;
}

/**
 * Exchange the authorization `code` for the connected account's tokens.
 * `clientSecret` is the PLATFORM's Stripe secret key (sk_… from the platform account).
 * Throws with Stripe's own message on any error (e.g. an already-used or expired code).
 */
export async function exchangeStripeConnectCode(
  input: { clientSecret: string; code: string },
  fetchImpl: FetchLike = fetch,
): Promise<StripeConnectTokens> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Authorization: `Bearer ${input.clientSecret}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code: input.code }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenSuccess & TokenError>;
  if (!res.ok || body.error || !body.access_token || !body.stripe_user_id) {
    const msg = body.error_description || body.error || `token exchange failed (${res.status})`;
    throw new Error(`Stripe Connect: ${msg}`);
  }
  return {
    stripeUserId: body.stripe_user_id,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    publishableKey: body.stripe_publishable_key,
    livemode: body.livemode ?? false,
    scope: body.scope,
  };
}

/** The keychain entries a successful connect should persist (UPPER_SNAKE_CASE → value). */
export function stripeKeychainEntries(tokens: StripeConnectTokens): Record<string, string> {
  const out: Record<string, string> = {
    STRIPE_SECRET_KEY: tokens.accessToken,
    STRIPE_ACCOUNT_ID: tokens.stripeUserId,
  };
  if (tokens.publishableKey) out.STRIPE_PUBLISHABLE_KEY = tokens.publishableKey;
  return out;
}
