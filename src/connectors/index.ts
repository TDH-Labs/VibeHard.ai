/**
 * Connectors — the "bring your own service" wizards a tenant runs from the dashboard to attach a
 * third-party account to their builds. Each validates/authorizes against the real provider, then
 * the web layer persists the resulting keys into the tenant's encrypted integrations keychain.
 *
 *  - Supabase: NO OAuth provider → a validated key-import wizard (prove the keys, then save).
 *  - Stripe:   real Connect (Standard) OAuth → the user authorizes, Stripe hands us the keys.
 */
export {
  validateSupabaseConnection,
  supabaseKeychainEntries,
  type SupabaseConnectInput,
  type SupabaseConnectResult,
  type ConnectCheck,
} from "./supabase-connect.ts";

export {
  stripeConnectAuthUrl,
  exchangeStripeConnectCode,
  stripeKeychainEntries,
  type StripeConnectAuthOptions,
  type StripeConnectTokens,
} from "./stripe-connect.ts";
