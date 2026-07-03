/**
 * Clerk auth integration (production-readiness loop, EPIC #34). VibeHard's consumer surface is a
 * custom Bun.serve server (not a framework Clerk's CLI scaffolds), so this is the manual integration:
 * @clerk/backend verifies the session server-side and ClerkJS drives the UI in web/app.html.
 *
 * ENV-GATED: Clerk is active only when BOTH CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are set. With
 * neither, the server keeps its legacy hand-rolled auth untouched — so adding the keys is the single
 * switch that flips the product onto Clerk (and retires the hand-rolled session/password surface).
 *
 * The pure, network-free bits live here and are unit-tested; web/server.ts wires them to the live
 * @clerk/backend client + request handler.
 */

export interface ClerkConfig {
  enabled: boolean;
  secretKey: string;
  publishableKey: string;
}

/** Read Clerk config from env. `enabled` iff both keys are present. The publishable key's VALUE is the
 *  same across frameworks — only the env-var prefix differs — so we accept the names people actually
 *  paste from dashboard snippets (Next.js `NEXT_PUBLIC_`, Vite `VITE_`) as well as the plain name. */
export function clerkConfig(env: Record<string, string | undefined> = process.env): ClerkConfig {
  const secretKey = env.CLERK_SECRET_KEY ?? "";
  const publishableKey = env.CLERK_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? env.VITE_CLERK_PUBLISHABLE_KEY ?? "";
  return { enabled: Boolean(secretKey && publishableKey), secretKey, publishableKey };
}

/**
 * Derive the Clerk Frontend API host from a publishable key. The key is `pk_<env>_<base64>` where the
 * base64 decodes to "<frontend-api-host>$"; ClerkJS's CDN bundle is served from that host. Returns
 * null for a malformed key. (Matches Clerk's own vanilla-JS quickstart derivation.)
 */
export function frontendApiFromPublishableKey(pk: string): string | null {
  const part = pk.split("_")[2];
  if (!part) return null;
  try {
    const decoded = atob(part);
    const host = decoded.endsWith("$") ? decoded.slice(0, -1) : decoded;
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Local-account lookup/creation seam — lets the resolver stay pure + testable (no Platform import). */
export interface ClerkTenantDeps {
  /** the Clerk user's primary email (caller fetches via clerkClient.users.getUser, cached) */
  getEmail: (userId: string) => Promise<string | null>;
  /** existing local account for this email, or null (the durable user store is async, so this
   *  may return a promise) */
  findTenantByEmail: (email: string) => string | null | Promise<string | null>;
  /** create a local tenant+user for a first-seen Clerk user; returns the new tenantId (durable
   *  tenant creation is async, so this may return a promise) */
  createTenant: (email: string, name: string, userId: string) => string | Promise<string>;
  /** display name for a first-seen user (optional; falls back to the email local-part) */
  getName?: (userId: string) => Promise<string | null>;
}

/**
 * Map a verified Clerk userId to a local tenant: reuse the account for that verified email if one
 * exists (account continuity across the legacy→Clerk cutover — Clerk has verified the address), else
 * create one. Returns null if the email can't be resolved.
 */
export async function resolveTenantForClerkUser(userId: string, deps: ClerkTenantDeps): Promise<{ email: string; tenantId: string } | null> {
  const email = (await deps.getEmail(userId))?.trim().toLowerCase();
  if (!email) return null;
  const existing = await deps.findTenantByEmail(email);
  if (existing) return { email, tenantId: existing };
  const name = (await deps.getName?.(userId))?.trim() || email.split("@")[0]!;
  return { email, tenantId: await deps.createTenant(email, name, userId) };
}
