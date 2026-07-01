/**
 * VibeHard alpha — the hosted product surface (LOCAL alpha; run with `bun web/server.ts`).
 *
 * Thin layer over the proven engine: real accounts (tenant store + hashed passwords), a per-tenant
 * encrypted LLM key (BYO), and a build endpoint that spawns the SAME `vibehard build` + `ship`
 * pipeline the CLI runs — full soup-to-nuts (spec → PRD → architecture → 7 gates → auto-fix →
 * managed Supabase provision → deploy) — and streams its live output to the browser over SSE. The
 * tenant's key is injected into the child process env, so each tenant's builds run on THEIR account.
 *
 * Honest limits (alpha): single-process, sessions in memory, builds run on this machine (not an
 * isolated sandbox), no public hosting. Good enough for you + a few trusted testers locally.
 */
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { Platform, StripeBillingProvider, StripeClient } from "../src/platform/index.ts";
import { llmInterviewer, type InterviewTurn } from "../src/spec/index.ts";
import { byoModelFactory } from "../src/engine/bolt/driver.ts";
import { applyBillingDecision, decideBillingEvent, parseStripeEvent, verifyStripeSignature } from "../src/platform/billing-webhook.ts";
import { LocalEscalationSink } from "../src/escalation/index.ts";
import { translateFinding } from "../src/translate/index.ts";
import { requiredCredentialsForApp } from "../src/credentials/index.ts";
import { llmFunctionalReviewer, summarize } from "../src/functest/functest.ts";
import { Orchestrator, type Channel, type OutboundMessage } from "../src/orchestrator/orchestrator.ts";
import { realBuildTools } from "../src/orchestrator/build-tools.ts";
import { llmClassifier } from "../src/orchestrator/orchestrator-llm.ts";
import { validateSupabaseConnection, supabaseKeychainEntries, stripeConnectAuthUrl, exchangeStripeConnectCode, stripeKeychainEntries } from "../src/connectors/index.ts";
import { isSafeAppName } from "../src/util/safe-path.ts";
import { createClerkClient } from "@clerk/backend";
import { clerkConfig, resolveTenantForClerkUser, frontendApiFromPublishableKey } from "../src/auth/clerk.ts";

const ROOT = join(homedir(), ".vibehard");
const WEB = join(ROOT, "web");
const USERS = join(WEB, "users.json");
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const APP_HTML = join(import.meta.dir, "app.html");
// B-5 (audit2): fail-closed — NO hardcoded default. The keychain (every tenant's LLM key + their
// Stripe/Supabase integration secrets) is encrypted under this key; a committed literal default
// means a default deployment is decryptable from source. Require a real, high-entropy key at
// startup or refuse to boot.
const KEY = (() => {
  const k = process.env.VIBEHARD_SECRETS_KEY;
  if (!k || k.length < 32) {
    throw new Error(
      "VIBEHARD_SECRETS_KEY is required and must be at least 32 characters — set it to a random secret " +
        "(e.g. `openssl rand -hex 32`) in your environment / .env before starting the server. Refusing to " +
        "boot with a weak or missing secrets-encryption key (audit B-5).",
    );
  }
  return k;
})();

// C-1/C3 (audit2): the deploy sentinel is HMAC-signed with VIBEHARD_SENTINEL_SECRET. The substrate
// has a dev fallback for local CLI use, but the multi-tenant web surface must never run on it — a
// known key lets a tenant forge .gate/HARD_VERIFY_PASS and self-authorize a deploy. Require it here.
if (!process.env.VIBEHARD_SENTINEL_SECRET || process.env.VIBEHARD_SENTINEL_SECRET.length < 32) {
  throw new Error(
    "VIBEHARD_SENTINEL_SECRET is required and must be at least 32 characters — set it to a random secret " +
      "(e.g. `openssl rand -hex 32`, distinct from VIBEHARD_SECRETS_KEY). Refusing to boot: a weak/missing " +
      "sentinel key lets a tenant forge a deploy authorization (audit C-1/C3).",
  );
}

// Billing (backlog #5) — wired ONLY when Stripe is configured; otherwise the platform keeps its
// LocalBillingProvider stub and the billing endpoints below are no-ops. The price→plan map (env
// JSON like {"price_xxx":"starter"}) is what the webhook uses to sync tenant.plan.
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const PRICE_TO_PLAN: Record<string, string> = (() => {
  try {
    return process.env.VIBEHARD_STRIPE_PRICE_MAP ? (JSON.parse(process.env.VIBEHARD_STRIPE_PRICE_MAP) as Record<string, string>) : {};
  } catch {
    return {};
  }
})();
const stripeBilling = STRIPE_SECRET ? new StripeBillingProvider({ client: new StripeClient({ secretKey: STRIPE_SECRET }), priceToPlan: PRICE_TO_PLAN }) : undefined;
// Stripe Connect (app-level "Connect Stripe"): the platform's Connect client id (ca_…) + the
// platform secret key (reused as the token-exchange client_secret). Connect is offered only when
// BOTH are present; otherwise the button reports "not configured" instead of dead-ending.
const STRIPE_CONNECT_CLIENT_ID = process.env.STRIPE_CONNECT_CLIENT_ID || "";
const stripeConnectStates = new Map<string, string>(); // state → tenantId (CSRF + carries who is connecting)
// Platform.open() (EPIC #33) wires the DURABLE tenant/secrets/deployment stores — managed Postgres
// via DATABASE_URL in the cloud, else embedded disk-persisted Postgres locally — so signups and
// deployed apps survive a restart/redeploy. `new Platform(...)` (file-backed only, wiped by an
// ephemeral cloud box) would silently lose this guarantee; Platform.open() is required here.
const { platform, db: platformDb } = await Platform.open({ baseDir: ROOT, billing: stripeBilling });
const seenBillingEvents = new Set<string>(); // processed Stripe event ids → drop replays (idempotency)

// ── tiny encrypted store for the per-tenant LLM key (AES-256-GCM) ───────────────
function encrypt(plain: string): string {
  const salt = randomBytes(16), iv = randomBytes(12), k = scryptSync(KEY, salt, 32);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plain, "utf8")), c.final()]);
  return Buffer.concat([salt, iv, c.getAuthTag(), ct]).toString("base64");
}
function decrypt(blob: string): string | null {
  try {
    const b = Buffer.from(blob, "base64");
    const tag = b.subarray(28, 44);
    if (tag.length !== 16) return null; // reject a truncated blob outright
    const k = scryptSync(KEY, b.subarray(0, 16), 32);
    // Pin the GCM auth-tag length (sast gcm-no-tag-length): without it Node accepts a shorter-than-
    // expected tag, weakening the forgery bound. We always wrote a full 16-byte tag, so require it.
    const d = createDecipheriv("aes-256-gcm", k, b.subarray(16, 28), { authTagLength: 16 });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(b.subarray(44)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
const keyPath = (tenantId: string) => join(ROOT, "tenants", tenantId.replace(/[^a-zA-Z0-9_-]/g, "_"), "llm-key.enc");
function saveKey(tenantId: string, key: string): void {
  const p = keyPath(tenantId);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, encrypt(key));
}
function loadKey(tenantId: string): string | null {
  const p = keyPath(tenantId);
  return existsSync(p) ? decrypt(readFileSync(p, "utf8")) : null;
}

// ── integrations keychain (backlog #5): a tenant's third-party keys (Stripe, OAuth, email…),
//    saved once (encrypted, each value separately) and injected into every build/ship subprocess. ──
const integrationsPath = (tenantId: string) => join(ROOT, "tenants", tenantId.replace(/[^a-zA-Z0-9_-]/g, "_"), "integrations.json");
function loadIntegrations(tenantId: string): Record<string, string> {
  const p = integrationsPath(tenantId);
  if (!existsSync(p)) return {};
  try {
    const enc = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(enc)) {
      try {
        out[k] = decrypt(v);
      } catch {
        /* skip a value we can't decrypt */
      }
    }
    return out;
  } catch {
    return {};
  }
}
function saveIntegration(tenantId: string, key: string, value: string): void {
  const p = integrationsPath(tenantId);
  mkdirSync(join(p, ".."), { recursive: true });
  const enc = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, string>) : {};
  enc[key] = encrypt(value);
  writeFileSync(p, JSON.stringify(enc, null, 2));
}
function integrationKeys(tenantId: string): string[] {
  return Object.keys(loadIntegrations(tenantId));
}

/** On boot, no build subprocess is alive, so any record still marked "running" is stale (the server
 *  died mid-build). Flip it to "paused" so it shows as resumable instead of falsely in-progress. */
function sweepStaleRunning(): void {
  const tdir = join(ROOT, "tenants");
  if (!existsSync(tdir)) return;
  for (const id of readdirSync(tdir)) {
    try {
      const ab = readActiveBuild(id);
      if (ab?.status === "running") writeActiveBuild(id, { ...ab, status: "paused" });
      const builds = listTenantBuilds(id);
      let changed = false;
      for (const b of builds) if (b.status === "running") ((b.status = "paused"), (changed = true));
      if (changed) saveTenantBuilds(id, builds);
    } catch {
      /* skip a tenant we can't read */
    }
  }
}

// ── users (email → {tenantId, name, hash}) ──────────────────────────────────────
type User = { tenantId: string; name: string; hash: string };
function users(): Record<string, User> {
  if (!existsSync(USERS)) return {};
  try {
    return JSON.parse(readFileSync(USERS, "utf8")) as Record<string, User>;
  } catch {
    return {};
  }
}
function putUser(email: string, u: User): void {
  mkdirSync(WEB, { recursive: true });
  const all = users();
  all[email] = u;
  writeFileSync(USERS, JSON.stringify(all, null, 2));
}

// ── sessions (in-memory; fine for a local single-process alpha) ─────────────────
// audit2 C-6: sessions now EXPIRE (TTL). An in-memory Map with no expiry meant a token was valid
// forever (until restart) — a leaked cookie never aged out. Tokens carry an absolute expiry and are
// dropped on lookup once past it.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessions = new Map<string, { email: string; expires: number }>(); // token → {email, expires}
const cookieOf = (req: Request) => /(?:^|;\s*)vh=([^;]+)/.exec(req.headers.get("cookie") || "")?.[1] ?? null;
/** Mint a session token bound to an email, with a TTL. */
function setSession(email: string): string {
  const token = randomUUID();
  sessions.set(token, { email, expires: Date.now() + SESSION_TTL_MS });
  return token;
}
/** Resolve a token → email, dropping it if expired. */
function sessionEmail(token: string | null): string | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s.email;
}
function userOf(req: Request): { email: string; user: User } | null {
  const email = sessionEmail(cookieOf(req));
  const u = email ? users()[email] : null;
  return email && u ? { email, user: u } : null;
}
// audit2 C-6: simple per-account login throttle (in-memory; alpha single-process).
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 8;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
function loginThrottled(key: string): boolean {
  const e = loginAttempts.get(key);
  const now = Date.now();
  if (!e || e.resetAt < now) {
    loginAttempts.set(key, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  return e.count >= LOGIN_MAX;
}
function loginFailed(key: string): void {
  const e = loginAttempts.get(key);
  if (e) e.count++;
}
function loginOk(key: string): void {
  loginAttempts.delete(key);
}
/** Same-origin guard (audit2 C-6 CSRF): a cross-site EventSource/fetch carries a foreign Origin
 *  header (these APIs are CORS-aware), so we reject a mutating request whose Origin isn't us. A
 *  same-origin call either omits Origin or matches BASE_URL. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // top-level navigations / same-origin GETs often omit it
  try {
    return new URL(origin).host === new URL(BASE_URL).host;
  } catch {
    return false;
  }
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

// ── the polished marketing site (the .dc design the operator chose) ─────────────
const DC_DIR = join(import.meta.dir, "..", "landing", "AI Software Builder Competitive Strategy");
async function serveStatic(path: string): Promise<Response> {
  const rel = path === "/" ? "index.dc.html" : decodeURIComponent(path.replace(/^\//, ""));
  if (rel.includes("..")) return new Response("forbidden", { status: 403 });
  const f = Bun.file(join(DC_DIR, rel));
  return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
}

// ── social login (Google + GitHub OAuth) ────────────────────────────────────────
const BASE_URL = process.env.BASE_URL || `http://localhost:${Number(process.env.PORT) || 4100}`;

// ── Clerk auth (EPIC #34) — ENV-GATED. Active iff CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY are set.
//    With them, Clerk verifies the session and the legacy hand-rolled auth is disabled; without them,
//    nothing changes (legacy auth stays). Adding the two keys is the single switch that flips it on. ──
const CLERK = clerkConfig();
const clerkClient = CLERK.enabled ? createClerkClient({ secretKey: CLERK.secretKey, publishableKey: CLERK.publishableKey }) : null;
const clerkEmailCache = new Map<string, string>(); // Clerk userId → email, to avoid a getUser per request

/** The single auth seam: with Clerk on, verify the Clerk session + map it to a local tenant; else the
 *  legacy session store. Returns null (unauthenticated) on any verification failure — never throws. */
async function authenticate(req: Request): Promise<{ email: string; user: User } | null> {
  if (!CLERK.enabled || !clerkClient) return userOf(req);
  try {
    const rs = await clerkClient.authenticateRequest(req, { authorizedParties: [BASE_URL] });
    if (!rs.isAuthenticated) return null;
    const userId = rs.toAuth().userId;
    if (!userId) return null;
    let userPromise: ReturnType<typeof clerkClient.users.getUser> | null = null;
    const getUserOnce = () => (userPromise ??= clerkClient.users.getUser(userId));
    const resolved = await resolveTenantForClerkUser(userId, {
      getEmail: async (id) => {
        const cached = clerkEmailCache.get(id);
        if (cached) return cached;
        const u = await getUserOnce();
        const email = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress ?? u.emailAddresses[0]?.emailAddress ?? null;
        if (email) clerkEmailCache.set(id, email);
        return email;
      },
      findTenantByEmail: (email) => users()[email]?.tenantId ?? null,
      createTenant: async (email, name, id) => {
        const t = await platform.signUp(name);
        putUser(email, { tenantId: t.id, name, hash: `clerk:${id}` }); // hash marks a Clerk-owned account (no password)
        return t.id;
      },
      getName: async (id) => {
        const u = await getUserOnce();
        return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || null;
      },
    });
    if (!resolved) return null;
    const user = users()[resolved.email];
    return user ? { email: resolved.email, user } : null;
  } catch {
    return null; // a failed/forged session → unauthenticated, fail-closed, never a crash
  }
}
// audit2 C-6: userInfo MUST report whether the provider VERIFIED the email. We only accept a verified
// address — otherwise a user could set any unverified email at the provider and sign in as that
// identity (→ silent merge onto a victim's account).
type Provider = { id?: string; secret?: string; authUrl: string; tokenUrl: string; scope: string; userInfo: (token: string) => Promise<{ email?: string; name?: string; verified?: boolean }> };
const PROVIDERS: Record<string, Provider> = {
  google: {
    id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", scope: "openid email profile",
    userInfo: async (t) => {
      const j = (await (await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${t}` } })).json()) as { email?: string; name?: string; verified_email?: boolean };
      return { email: j.email, name: j.name, verified: j.verified_email === true };
    },
  },
  github: {
    id: process.env.GITHUB_CLIENT_ID, secret: process.env.GITHUB_CLIENT_SECRET,
    authUrl: "https://github.com/login/oauth/authorize", tokenUrl: "https://github.com/login/oauth/access_token", scope: "read:user user:email",
    userInfo: async (t) => {
      const hdr = { Authorization: `Bearer ${t}`, "User-Agent": "vibehard", Accept: "application/vnd.github+json" };
      const u = (await (await fetch("https://api.github.com/user", { headers: hdr })).json()) as { name?: string; login?: string };
      // Only a PRIMARY + VERIFIED email counts — never u.email (which may be an unverified profile field).
      const es = (await (await fetch("https://api.github.com/user/emails", { headers: hdr })).json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      const chosen = Array.isArray(es) ? es.find((e) => e.primary && e.verified) : undefined;
      return { email: chosen?.email, name: u.name || u.login, verified: Boolean(chosen) };
    },
  },
};
const oauthStates = new Map<string, string>();
const startSession = (email: string): string => setSession(email); // TTL-backed (audit2 C-6)
/** Resolve an OAuth identity to an account, creating one on first sight. audit2 C-6: NEVER silently
 *  log into a pre-existing PASSWORD account via OAuth (that's account takeover — the OAuth side proves
 *  control of the provider identity, not of the local password account). Same-email OAuth accounts are
 *  fine (the verified email is the same person across providers). */
async function ensureUser(email: string, name: string, provider: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const existing = users()[email];
  if (!existing) {
    const tenant = await platform.signUp(name || email.split("@")[0]!);
    putUser(email, { tenantId: tenant.id, name: name || email, hash: `oauth:${provider}` });
    return { ok: true };
  }
  if (existing.hash.startsWith("oauth:")) return { ok: true }; // already an OAuth account → sign in
  return { ok: false, reason: "password-account-exists" }; // refuse OAuth onto a password account
}
const redirect = (location: string, cookie?: string): Response =>
  new Response(null, { status: 302, headers: { location, ...(cookie ? { "set-cookie": cookie } : {}) } });

async function handleOAuth(url: URL, path: string): Promise<Response> {
  if (CLERK.enabled) return redirect("/app?error=use-clerk"); // Clerk owns auth — legacy social login off
  const parts = path.split("/"); // ["", "auth", provider, action?]
  const provider = parts[2] || "";
  const action = parts[3] || "";
  const cfg = PROVIDERS[provider];
  if (!cfg) return new Response("unknown provider", { status: 404 });
  if (!cfg.id || !cfg.secret) return redirect(`/app?error=${provider}-not-configured`);
  const redirectUri = `${BASE_URL}/auth/${provider}/callback`;
  if (action !== "callback") {
    const state = randomUUID();
    oauthStates.set(state, provider);
    const a = new URL(cfg.authUrl);
    a.searchParams.set("client_id", cfg.id);
    a.searchParams.set("redirect_uri", redirectUri);
    a.searchParams.set("response_type", "code");
    a.searchParams.set("scope", cfg.scope);
    a.searchParams.set("state", state);
    return redirect(a.toString());
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || oauthStates.get(state) !== provider) return redirect("/app?error=oauth-state");
  oauthStates.delete(state);
  const tok = (await (
    await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: cfg.id, client_secret: cfg.secret, code, redirect_uri: redirectUri, grant_type: "authorization_code" }).toString(),
    })
  ).json()) as { access_token?: string };
  if (!tok.access_token) return redirect("/app?error=oauth-token");
  const { email, name, verified } = await cfg.userInfo(tok.access_token);
  if (!email) return redirect("/app?error=oauth-email");
  if (!verified) return redirect("/app?error=oauth-unverified-email"); // audit2 C-6: never trust an unverified address
  const res = await ensureUser(email, name || email, provider);
  if (!res.ok) return redirect("/app?error=use-password-login"); // a password account owns this email — no silent merge
  return redirect("/app", `vh=${startSession(email)}; Path=/; HttpOnly; SameSite=Lax`);
}

// ── Stripe Connect ("Connect Stripe"): real Connect OAuth. /connect (authed) sends the tenant to
//    Stripe; /callback exchanges the code for THEIR account's keys and saves them to the keychain. ──
async function handleStripeConnect(req: Request, url: URL, path: string): Promise<Response> {
  if (!STRIPE_CONNECT_CLIENT_ID || !STRIPE_SECRET) return redirect("/app?connect=stripe-not-configured");

  if (path === "/auth/stripe/connect") {
    const who = await authenticate(req);
    if (!who) return redirect("/app?connect=signin-first");
    const state = randomUUID();
    stripeConnectStates.set(state, who.user.tenantId);
    return redirect(stripeConnectAuthUrl({
      clientId: STRIPE_CONNECT_CLIENT_ID,
      state,
      redirectUri: `${BASE_URL}/auth/stripe/callback`,
      stripeUser: { email: who.email, businessName: who.user.name },
    }));
  }

  // callback
  if (url.searchParams.get("error")) return redirect("/app?connect=stripe-denied"); // user declined on Stripe
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const tenantId = state ? stripeConnectStates.get(state) : undefined;
  if (!code || !state || !tenantId) return redirect("/app?connect=stripe-state");
  stripeConnectStates.delete(state);
  try {
    const tokens = await exchangeStripeConnectCode({ clientSecret: STRIPE_SECRET, code });
    for (const [k, v] of Object.entries(stripeKeychainEntries(tokens))) saveIntegration(tenantId, k, v);
    return redirect(`/app?connect=stripe-ok${tokens.livemode ? "" : "-test"}`);
  } catch {
    return redirect("/app?connect=stripe-failed"); // never surface the raw error / any key material
  }
}

// ── password reset (token sent via a side-channel: email if Resend is configured, else the
//    server console — NEVER returned in the response, so it can't be used to hijack an account) ──
const resetTokens = new Map<string, { email: string; expires: number }>();
/** Email the reset link via Resend. Returns true iff it was actually accepted for delivery —
 *  the caller uses that to decide whether to fall back to the in-dashboard link (local only). */
async function sendResetLink(email: string, link: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`\n[reset] no RESEND_API_KEY — give this reset link to ${email}:\n  ${link}\n`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "VibeHard <onboarding@resend.dev>",
        to: email,
        subject: "Reset your VibeHard password",
        html: `<p>Someone asked to reset your VibeHard password. If it was you, set a new one:</p><p><a href="${link}">${link}</a></p><p>This link expires in 1 hour. If it wasn't you, ignore this email.</p>`,
      }),
    });
    if (res.ok) {
      console.log(`[reset] emailed a reset link to ${email}`);
      return true;
    }
    // e.g. Resend test-mode rejects non-owner recipients until a domain is verified.
    console.log(`[reset] email not delivered (${res.status}) — reset link for ${email}:\n  ${link}`);
    return false;
  } catch {
    console.log(`[reset] email error — reset link for ${email}:\n  ${link}`);
    return false;
  }
}

// ── build control: track the running subprocess per tenant (for Stop) + persist the active build
//    so a stopped build can be resumed, even across a page reload ──
const running = new Map<string, Bun.Subprocess>();
const stopFlags = new Set<string>();
const tenantDir = (tenantId: string) => join(ROOT, "tenants", tenantId.replace(/[^a-zA-Z0-9_-]/g, "_"));
type ActiveBuild = { app: string; prompt: string; status: "running" | "paused" | "live" | "blocked" | "deploy-failed" | "error" };
function readActiveBuild(tenantId: string): ActiveBuild | null {
  const p = join(tenantDir(tenantId), "active-build.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ActiveBuild;
  } catch {
    return null;
  }
}
function writeActiveBuild(tenantId: string, b: ActiveBuild): void {
  mkdirSync(tenantDir(tenantId), { recursive: true });
  writeFileSync(join(tenantDir(tenantId), "active-build.json"), JSON.stringify(b, null, 2));
}

// ── persistent build history (so projects survive re-login; the "Your projects" list) ──────────
type BuildRecord = { app: string; prompt: string; status: ActiveBuild["status"]; at: number; ticket?: string; url?: string };
function buildsFile(tenantId: string): string {
  return join(tenantDir(tenantId), "builds.json");
}
function listTenantBuilds(tenantId: string): BuildRecord[] {
  const p = buildsFile(tenantId);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as BuildRecord[];
  } catch {
    return [];
  }
}
function saveTenantBuilds(tenantId: string, list: BuildRecord[]): void {
  mkdirSync(tenantDir(tenantId), { recursive: true });
  writeFileSync(buildsFile(tenantId), JSON.stringify(list.slice(0, 50), null, 2));
}
function appendBuild(tenantId: string, rec: BuildRecord): void {
  const list = listTenantBuilds(tenantId);
  list.unshift(rec);
  saveTenantBuilds(tenantId, list);
}
function patchBuild(tenantId: string, app: string, patch: Partial<BuildRecord>): void {
  const list = listTenantBuilds(tenantId);
  const i = list.findIndex((b) => b.app === app);
  if (i >= 0) {
    list[i] = { ...list[i]!, ...patch };
    saveTenantBuilds(tenantId, list);
  }
}

// ── orchestrator: the conversational owner of a build (the chat panel's backend) ───────────
type InboxMsg = { at: number; kind: OutboundMessage["kind"]; text: string };
const inboxPath = (tenantId: string, app: string) => join(tenantDir(tenantId), "apps", app, ".vibehard", "orchestrator-inbox.json");
function readInbox(tenantId: string, app: string): InboxMsg[] {
  try {
    return JSON.parse(readFileSync(inboxPath(tenantId, app), "utf8")) as InboxMsg[];
  } catch {
    return [];
  }
}
function appendInbox(tenantId: string, app: string, m: OutboundMessage): void {
  const p = inboxPath(tenantId, app);
  mkdirSync(join(tenantDir(tenantId), "apps", app, ".vibehard"), { recursive: true });
  const list = readInbox(tenantId, app);
  list.push({ at: Date.now(), kind: m.kind, text: m.text });
  writeFileSync(p, JSON.stringify(list.slice(-200), null, 2));
}
// one orchestrator per (tenant, app) so the confirm-state survives across requests
const orchestrators = new Map<string, Orchestrator>();
function getOrchestrator(tenantId: string, app: string): Orchestrator {
  const key = `${tenantId}:${app}`;
  let o = orchestrators.get(key);
  if (!o) {
    const workspace = join(tenantDir(tenantId), "apps", app);
    const channel: Channel = { send: (m) => appendInbox(tenantId, app, m) };
    const byo = loadKey(tenantId);
    const modelFactory = byo ? byoModelFactory(byo.startsWith("sk-ant-") ? { anthropicKey: byo } : { openaiKey: byo }) : undefined;
    const tools = realBuildTools(workspace, {
      onRetryDone: (ok) =>
        channel.send(ok ? { kind: "done", text: '✅ The build landed clean — all gates pass. Say "ship" when you want to deploy.' } : { kind: "error", text: '🛑 It stopped again. Say "why" and I\'ll tell you the blocker.' }),
    });
    o = new Orchestrator(tools, channel, llmClassifier({ modelFactory }));
    orchestrators.set(key, o);
  }
  return o;
}

const server = Bun.serve({
  port: Number(process.env.PORT) || 4000,
  idleTimeout: 240, // builds stream for minutes
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/app" || path === "/reset") return new Response(Bun.file(APP_HTML));
    if (path === "/auth/stripe/connect" || path === "/auth/stripe/callback") return handleStripeConnect(req, url, path);
    if (path.startsWith("/auth/")) return handleOAuth(url, path);

    // Public: tells the frontend whether to render Clerk's UI (+ the publishable key, which is
    // public-safe) or the legacy login form. No auth required.
    if (path === "/api/auth-config") {
      return json({
        clerk: CLERK.enabled,
        publishableKey: CLERK.enabled ? CLERK.publishableKey : "",
        frontendApi: CLERK.enabled ? frontendApiFromPublishableKey(CLERK.publishableKey) : "",
      });
    }

    // Clerk on → the legacy email/password endpoints are a parallel auth surface; disable them.
    if (CLERK.enabled && (path === "/api/signup" || path === "/api/login" || path === "/api/forgot" || path === "/api/reset")) {
      return json({ error: "authentication is handled by Clerk" }, 400);
    }

    if (path === "/api/signup" && req.method === "POST") {
      const { email, password, name } = (await req.json()) as { email?: string; password?: string; name?: string };
      if (!email || !password || password.length < 8) return json({ error: "email and an 8+ char password are required" }, 400);
      if (users()[email]) return json({ error: "an account with that email already exists" }, 409);
      const tenant = await platform.signUp(name || email.split("@")[0]!);
      putUser(email, { tenantId: tenant.id, name: name || email, hash: await Bun.password.hash(password) });
      const token = setSession(email);
      return json({ ok: true, tenantId: tenant.id }, 200, { "set-cookie": `vh=${token}; Path=/; HttpOnly; SameSite=Lax` });
    }

    if (path === "/api/login" && req.method === "POST") {
      const { email, password } = (await req.json()) as { email?: string; password?: string };
      const key = (email ?? "").toLowerCase().trim();
      // audit2 C-6: throttle password guessing per account (in-memory; alpha single-process).
      if (key && loginThrottled(key)) return json({ error: "too many attempts — wait a few minutes and try again" }, 429);
      const u = email ? users()[email] : null;
      // OAuth accounts have no password (hash is `oauth:<provider>`) — never let password-verify pass on them.
      const ok = !!u && !!email && !!password && !u.hash.startsWith("oauth:") && (await Bun.password.verify(password, u.hash));
      if (!ok) {
        if (key) loginFailed(key);
        return json({ error: "wrong email or password" }, 401);
      }
      if (key) loginOk(key);
      const token = setSession(email!);
      return json({ ok: true }, 200, { "set-cookie": `vh=${token}; Path=/; HttpOnly; SameSite=Lax` });
    }

    if (path === "/api/forgot" && req.method === "POST") {
      const { email } = (await req.json()) as { email?: string };
      const u = email ? users()[email] : null;
      let devLink: string | undefined;
      // Only email/password accounts can reset (OAuth accounts have no password to set).
      if (u && email && !u.hash.startsWith("oauth:")) {
        const token = randomUUID();
        resetTokens.set(token, { email, expires: Date.now() + 3_600_000 });
        const link = `${BASE_URL}/reset?token=${token}`;
        const sent = await sendResetLink(email, link);
        // If the email couldn't be delivered (no provider, or Resend test-mode rejecting a
        // non-owner recipient), fall back to handing the link back — but ONLY on a localhost
        // instance, never when hosted (BASE_URL isn't localhost).
        if (!sent && BASE_URL.includes("localhost")) devLink = link;
      }
      // Generic response (never reveal whether an account exists) — plus devLink in local mode.
      return json({ ok: true, ...(devLink ? { devLink } : {}) });
    }

    if (path === "/api/reset" && req.method === "POST") {
      const { token, password } = (await req.json()) as { token?: string; password?: string };
      const entry = token ? resetTokens.get(token) : null;
      if (!entry || entry.expires < Date.now()) return json({ error: "this reset link is invalid or has expired — request a new one" }, 400);
      if (!password || password.length < 8) return json({ error: "the new password must be at least 8 characters" }, 400);
      const u = users()[entry.email];
      if (!u) return json({ error: "that account no longer exists" }, 400);
      u.hash = await Bun.password.hash(password);
      putUser(entry.email, u);
      resetTokens.delete(token);
      return json({ ok: true });
    }

    if (path === "/api/logout" && req.method === "POST") {
      sessions.delete(cookieOf(req) || "");
      return json({ ok: true }, 200, { "set-cookie": "vh=; Path=/; Max-Age=0" });
    }

    const auth = await authenticate(req);

    if (path === "/api/me") {
      if (!auth) return json({ authed: false });
      const t = await platform.getTenant(auth.user.tenantId);
      return json({
        authed: true,
        email: auth.email,
        name: auth.user.name,
        plan: t?.plan ?? "free",
        hasKey: loadKey(auth.user.tenantId) !== null,
        builds: listTenantBuilds(auth.user.tenantId), // persistent project history (survives re-login)
        activeBuild: readActiveBuild(auth.user.tenantId), // a running/paused build the dashboard can stop or resume
      });
    }

    if (path === "/api/key" && req.method === "POST") {
      if (!auth) return json({ error: "sign in first" }, 401);
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403); // audit3 D-2 CSRF
      const { key } = (await req.json()) as { key?: string };
      const k = key?.trim() ?? "";
      // audit2 C-6: don't accept any 20-char blob — require a recognized provider prefix, or a long
      // opaque token (real keys are 40+ chars), bounded to keep junk out of the keychain.
      const looksLikeKey = /^(sk-ant-|sk-|sk_|sbp_|xai-|gsk_)[A-Za-z0-9_-]{16,}$/.test(k) || /^[A-Za-z0-9_-]{40,200}$/.test(k);
      if (!looksLikeKey) return json({ error: "that doesn't look like an API key" }, 400);
      saveKey(auth.user.tenantId, k);
      return json({ ok: true });
    }

    if (path === "/api/billing/checkout" && req.method === "POST") {
      if (!auth) return json({ error: "sign in first" }, 401);
      if (!stripeBilling) return json({ error: "billing isn't configured" }, 503);
      const { priceId } = (await req.json()) as { priceId?: string };
      if (!priceId) return json({ error: "which plan? (priceId required)" }, 400);
      try {
        const customer = await stripeBilling.stripe.createCustomer({ email: auth.email, name: auth.user.name, tenantId: auth.user.tenantId });
        const session = await stripeBilling.stripe.createCheckoutSession({
          customerId: customer.id,
          priceId,
          tenantId: auth.user.tenantId, // stamped onto the subscription → the webhook resolves the tenant
          successUrl: `${url.origin}/?billing=success`,
          cancelUrl: `${url.origin}/?billing=cancel`,
        });
        return json({ url: session.url });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "checkout failed" }, 502);
      }
    }

    if (path === "/api/billing/webhook" && req.method === "POST") {
      // UNTRUSTED + UNAUTHENTICATED (Stripe calls it). The signature over the RAW body is the gate;
      // nothing mutates a tenant unless it verifies. A verified event always 200s (even when ignored)
      // so Stripe doesn't retry-storm; only a BAD SIGNATURE is rejected (400).
      if (!stripeBilling || !STRIPE_WEBHOOK_SECRET) return json({ error: "billing isn't configured" }, 503);
      const raw = await req.text();
      const sig = req.headers.get("stripe-signature") || "";
      if (!verifyStripeSignature(raw, sig, STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000))) {
        return json({ error: "bad signature" }, 400);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return json({ error: "bad json" }, 400);
      }
      const event = parseStripeEvent(parsed);
      // Replay/idempotency: a validly-signed event can be re-delivered within the 300s window;
      // drop one we've already applied so a captured legit event can't be replayed to fight a
      // later one. In-memory (single-process alpha) bounded set — survives the process, not a restart.
      if (event.id) {
        if (seenBillingEvents.has(event.id)) return json({ received: true, duplicate: true });
        seenBillingEvents.add(event.id);
        if (seenBillingEvents.size > 5000) seenBillingEvents.delete(seenBillingEvents.values().next().value!);
      }
      const decision = decideBillingEvent(event, PRICE_TO_PLAN);
      try {
        const note = await applyBillingDecision(decision, {
          setPlan: (id, plan) => platform.setPlan(id, plan),
          suspend: (id) => platform.suspend(id),
          resume: (id) => platform.resume(id),
        });
        console.log(`[billing] ${note}`);
      } catch (e) {
        console.log(`[billing] apply skipped: ${e instanceof Error ? e.message : e}`); // unknown tenant etc — still ack
      }
      return json({ received: true });
    }

    if (path === "/api/intake/next" && req.method === "POST") {
      // grill-me INTERVIEW: one question at a time. Given the prompt + the Q&A so far, return the
      // next question (with a recommended answer) or {done:true}. Fail-safe: any error → done.
      if (!auth) return json({ error: "sign in first" }, 401);
      const { prompt, history } = (await req.json()) as { prompt?: string; history?: InterviewTurn[] };
      if (!prompt?.trim()) return json({ done: true });
      try {
        const byo = loadKey(auth.user.tenantId);
        const modelFactory = byo ? byoModelFactory(byo.startsWith("sk-ant-") ? { anthropicKey: byo } : { openaiKey: byo }) : undefined;
        return json(await llmInterviewer({ modelFactory })(prompt.trim(), Array.isArray(history) ? history : []));
      } catch {
        return json({ done: true }); // optional — never block the build
      }
    }

    if (path === "/api/held") {
      // What a HELD build flagged, in plain English — so "held for review" isn't a dead-end.
      if (!auth) return json({ error: "sign in first" }, 401);
      const app = url.searchParams.get("app");
      const rec = listTenantBuilds(auth.user.tenantId).find((b) => b.app === app);
      if (!rec?.ticket) return json({ state: null, findings: [] });
      const sink = new LocalEscalationSink(process.env.VIBEHARD_QUEUE_DIR ?? join(homedir(), ".vibehard", "queue"));
      const ticket = await sink.get(rec.ticket);
      if (!ticket) return json({ state: null, findings: [] });
      const findings = ticket.packet.items.map((it) => {
        const e = translateFinding(it.finding);
        return { area: it.specialty, title: e.title, detail: e.detail, severity: it.finding.severity, file: it.finding.file };
      });
      return json({ state: ticket.state, claimedBy: ticket.claimedBy, ticket: ticket.id, findings });
    }

    if (path === "/api/orchestrator/message" && req.method === "POST") {
      // Inbound: a message to the build's orchestrator → a real action + a reply.
      if (!auth) return json({ error: "sign in first" }, 401);
      const { app, text } = (await req.json()) as { app?: string; text?: string };
      if (!app || !text?.trim()) return json({ error: "app and text required" }, 400);
      if (!listTenantBuilds(auth.user.tenantId).some((b) => b.app === app)) return json({ error: "unknown build" }, 404);
      const reply = await getOrchestrator(auth.user.tenantId, app).onMessage(text.trim());
      return json({ reply });
    }

    if (path === "/api/orchestrator/inbox") {
      // Outbound: proactive messages the orchestrator pushed (held, build-landed, …) since `since`.
      if (!auth) return json({ messages: [] });
      const app = url.searchParams.get("app");
      const since = Number(url.searchParams.get("since") ?? 0);
      // C1: `app` is a path segment — reject traversal before it reaches readInbox's join().
      if (!app || !isSafeAppName(app)) return json({ messages: [] });
      return json({ messages: readInbox(auth.user.tenantId, app).filter((m) => m.at > since) });
    }

    if (path === "/api/functest") {
      // #11: LLM QA — does the built app implement the features the spec captured? (advisory)
      if (!auth) return json({ checks: [] });
      const app = url.searchParams.get("app");
      const rec = app ? listTenantBuilds(auth.user.tenantId).find((b) => b.app === app) : null;
      if (!rec) return json({ checks: [] });
      const workspace = join(tenantDir(auth.user.tenantId), "apps", app!);
      const specPath = join(workspace, ".vibehard", "spec.json");
      if (!existsSync(specPath)) return json({ checks: [] });
      try {
        const spec = JSON.parse(readFileSync(specPath, "utf8")) as { features?: string[] };
        const features = Array.isArray(spec.features) ? spec.features : [];
        if (!features.length) return json({ checks: [] });
        const byo = loadKey(auth.user.tenantId);
        const modelFactory = byo ? byoModelFactory(byo.startsWith("sk-ant-") ? { anthropicKey: byo } : { openaiKey: byo }) : undefined;
        const checks = await llmFunctionalReviewer({ modelFactory })(features, workspace);
        return json({ checks, summary: summarize(checks) });
      } catch {
        return json({ checks: [] });
      }
    }

    if (path === "/api/integrations" && req.method === "POST") {
      // Save one third-party key into the tenant's keychain (encrypted). Injected into builds/ships.
      if (!auth) return json({ error: "sign in first" }, 401);
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403); // audit3 D-2 CSRF
      const { key, value } = (await req.json()) as { key?: string; value?: string };
      if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) return json({ error: "key must be UPPER_SNAKE_CASE" }, 400);
      if (!value || !value.trim()) return json({ error: "value required" }, 400);
      saveIntegration(auth.user.tenantId, key, value.trim());
      return json({ ok: true });
    }

    if (path === "/api/connect/supabase" && req.method === "POST") {
      // Validated key-import wizard: PROVE the URL + anon + service keys against the live project,
      // then persist all three to the keychain. A wrong paste fails here, not silently at deploy.
      if (!auth) return json({ error: "sign in first" }, 401);
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403); // audit3 D-2 CSRF
      const { url: sbUrl, anonKey, serviceKey } = (await req.json()) as { url?: string; anonKey?: string; serviceKey?: string };
      const result = await validateSupabaseConnection({ url: sbUrl ?? "", anonKey: anonKey ?? "", serviceKey: serviceKey ?? "" });
      if (!result.ok) return json({ ok: false, checks: result.checks }, 400);
      for (const [k, v] of Object.entries(supabaseKeychainEntries({ url: sbUrl!, anonKey: anonKey!, serviceKey: serviceKey! }))) saveIntegration(auth.user.tenantId, k, v);
      return json({ ok: true, ref: result.ref, checks: result.checks });
    }

    if (path === "/api/connect/status") {
      // Which connectors the tenant has wired (presence only — never the values) + which are offered.
      if (!auth) return json({ error: "sign in first" }, 401);
      const have = integrationKeys(auth.user.tenantId);
      return json({
        supabase: have.includes("SUPABASE_URL") && have.includes("SUPABASE_SERVICE_ROLE_KEY"),
        stripe: have.includes("STRIPE_SECRET_KEY"),
        stripeOffered: Boolean(STRIPE_CONNECT_CLIENT_ID && STRIPE_SECRET),
      });
    }

    if (path === "/api/credentials") {
      // What third-party keys the built app needs (from its .env.example) + which the tenant has saved.
      if (!auth) return json({ error: "sign in first" }, 401);
      const app = url.searchParams.get("app");
      const rec = app ? listTenantBuilds(auth.user.tenantId).find((b) => b.app === app) : null;
      if (!rec) return json({ required: [], have: [] });
      const required = requiredCredentialsForApp(join(tenantDir(auth.user.tenantId), "apps", app!));
      return json({ required, have: integrationKeys(auth.user.tenantId) });
    }

    if (path === "/api/build/stop" && req.method === "POST") {
      if (!auth) return json({ error: "sign in first" }, 401);
      stopFlags.add(auth.user.tenantId);
      running.get(auth.user.tenantId)?.kill(); // the running build sees the flag → finishes as "paused"
      return json({ ok: true });
    }

    if (path === "/api/build") {
      // GET so the browser can stream it with EventSource (cookie auth is sent same-origin).
      if (!auth) return json({ error: "sign in first" }, 401);
      // audit2 C-6: this GET has side effects (spawns a build) — reject a cross-origin caller (CSRF).
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403);
      const prompt = url.searchParams.get("prompt")?.trim();
      const resumeApp = url.searchParams.get("app")?.trim() || undefined; // resume an existing workspace
      const design = url.searchParams.get("design")?.trim() || undefined; // #12 chosen design preset
      if (!prompt) return json({ error: "describe what to build" }, 400);
      // C1: a resume target is a path segment — refuse traversal into another tenant's workspace.
      if (resumeApp && !isSafeAppName(resumeApp)) return json({ error: "invalid app id" }, 400);
      // audit2 C-6: enforce tenant status + daily build quota (and meter) BEFORE spawning — derive the
      // app id here so the metered id matches the workspace the build uses.
      const app = resumeApp ?? `app-${Date.now().toString(36)}`;
      const denied = await guardBuild(auth.user.tenantId, app);
      if (denied) return json({ error: denied }, 403);
      return buildStream(auth.user.tenantId, prompt, app, "build", design);
    }

    if (path === "/api/redeploy" || path === "/api/polish") {
      // redeploy: re-ship with the tenant's now-saved keys (#5). polish: art-director pass + re-ship (#12).
      if (!auth) return json({ error: "sign in first" }, 401);
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403); // audit2 C-6 CSRF
      const app = url.searchParams.get("app")?.trim();
      const rec = app ? listTenantBuilds(auth.user.tenantId).find((b) => b.app === app) : null;
      if (!rec) return json({ error: "no such build" }, 404);
      const denied = await guardBuild(auth.user.tenantId, app!);
      if (denied) return json({ error: denied }, 403);
      return buildStream(auth.user.tenantId, rec.prompt, app, path === "/api/polish" ? "polish" : "ship");
    }

    // marketing site (the .dc design) — static fallback for "/" and every *.dc.html / asset
    return serveStatic(path);
  },
});

/** Spawn the real `vibehard build` (then `ship`) and stream every line to the browser as SSE.
 *  RESUMABLE: pass an existing `app` to continue a paused build (the CLI restores saved stages).
 *  STOPPABLE: the running subprocess is tracked (per tenant) so /api/build/stop can pause it; the
 *  build keeps running server-side even if the browser disconnects — active-build.json is truth. */
/** audit2 C-6: enforce tenant status + daily build quota and METER the build BEFORE any work runs.
 *  Returns an error message to surface (403), or null if allowed. Wraps Platform.submitBuild, which
 *  fail-closes on a suspended/unknown tenant or an exceeded rate. */
async function guardBuild(tenantId: string, app: string): Promise<string | null> {
  try {
    await platform.submitBuild(tenantId, app);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "build not allowed";
  }
}

function buildStream(tenantId: string, prompt: string, resumeApp?: string, mode: "build" | "ship" | "polish" = "build", design?: string): Response {
  // C1/B-4 (defense in depth): every caller validates resumeApp, but this is the choke point that
  // mkdirSync's + execs in the workspace, so an unsafe value here can never form a path — fall
  // back to a fresh, always-safe id rather than traverse.
  const app = resumeApp && isSafeAppName(resumeApp) ? resumeApp : `app-${Date.now().toString(36)}`;
  const appsRoot = join(tenantDir(tenantId), "apps");
  const workspace = join(appsRoot, app);
  // B-4 (audit2) belt-and-suspenders: assert the resolved workspace is still INSIDE this tenant's
  // apps/ root before we mkdir + exec in it. isSafeAppName already rejects separators/“..”, so this
  // can only fire on a future regression — but a containment break here is a cross-tenant write/RCE,
  // so we verify it deterministically rather than trust the validator alone.
  if (resolve(workspace) !== resolve(appsRoot, app) || !(resolve(workspace) + sep).startsWith(resolve(appsRoot) + sep)) {
    throw new Error("workspace path escaped the tenant apps root — refusing (B-4)");
  }
  mkdirSync(workspace, { recursive: true });
  stopFlags.delete(tenantId);
  writeActiveBuild(tenantId, { app, prompt, status: "running" });
  // Record in the persistent history (or flip an existing record back to running on resume).
  if (resumeApp && listTenantBuilds(tenantId).some((b) => b.app === app)) patchBuild(tenantId, app, { status: "running" });
  else appendBuild(tenantId, { app, prompt, status: "running", at: Date.now() });
  let heldTicket: string | undefined; // captured from the build's ::held marker
  let liveUrl: string | undefined; // captured from ship's "LIVE → <url>" line
  const byo = loadKey(tenantId);
  // The tenant's key (if set) overrides the operator's for THIS build's child process.
  const env: Record<string, string> = { ...process.env, VIBEHARD_MANAGED: "1" };
  if (byo) {
    if (byo.startsWith("sk-ant-")) env.ANTHROPIC_API_KEY = byo;
    else env.OPENCODE_API_KEY = byo; // OpenAI-compatible / gateway key
  }
  Object.assign(env, loadIntegrations(tenantId)); // the tenant's third-party keys → deploy injects the app's subset (#5)
  // C-6 (audit3): the build subprocess env merges operator + tenant values; tell deploy-time
  // collectAppEnv which keys are the TENANT's own (their keychain) so an operator value under a
  // colliding name (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) is never injected into the tenant app.
  env.VIBEHARD_TENANT_KEYS = integrationKeys(tenantId).join(",");
  if (design) env.VIBEHARD_DESIGN = design; // #12: the chosen design preset → codegen styling
  const enc = new TextEncoder();
  const finish = (status: ActiveBuild["status"]) => {
    writeActiveBuild(tenantId, { app, prompt, status });
    patchBuild(tenantId, app, { status, ...(heldTicket ? { ticket: heldTicket } : {}), ...(liveUrl ? { url: liveUrl } : {}) });
  };
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* browser disconnected (e.g. page reload) — build continues; active-build.json is truth */
        }
      };
      const runStep = async (label: string, args: string[]): Promise<number> => {
        send("step", label);
        const proc = Bun.spawn(["bun", CLI, ...args], { cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" });
        running.set(tenantId, proc);
        const pump = async (rs: ReadableStream<Uint8Array>) => {
          const reader = rs.getReader();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += new TextDecoder().decode(value);
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const ln of lines) {
              if (!ln.trim()) continue;
              const h = ln.match(/::held (\S+)/);
              if (h) {
                heldTicket = h[1]; // internal marker → capture, don't show
                continue;
              }
              const u = ln.match(/LIVE → (\S+)/);
              if (u) liveUrl = u[1];
              send("log", ln);
            }
          }
          if (buf.trim()) send("log", buf);
        };
        await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
        const code = await proc.exited;
        running.delete(tenantId);
        return code;
      };
      const stopped = () => stopFlags.has(tenantId);
      try {
        if (mode === "build") {
          const buildCode = await runStep("Building + gating your app…", ["build", prompt, workspace]);
          if (stopped()) {
            stopFlags.delete(tenantId);
            finish("paused");
            return send("done", "paused");
          }
          if (buildCode !== 0) {
            finish("blocked"); // gate held or the build couldn't pass
            return send("done", "blocked");
          }
        } else if (mode === "polish") {
          await runStep("Polishing the design…", ["polish", workspace]); // reverts itself if it would break; then we re-ship
        }
        const shipLabel = mode === "build" ? "Provisioning your database + deploying…" : mode === "polish" ? "Deploying the polished design…" : "Re-deploying with your saved keys…";
        const shipCode = await runStep(shipLabel, ["ship", workspace]);
        if (stopped()) {
          stopFlags.delete(tenantId);
          finish("paused");
          return send("done", "paused");
        }
        const status = shipCode === 0 ? "live" : "deploy-failed";
        finish(status);
        send("done", status);
      } catch (e) {
        finish("error");
        send("log", `error: ${e instanceof Error ? e.message : String(e)}`);
        send("done", "error");
      } finally {
        running.delete(tenantId);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

sweepStaleRunning(); // resolve any builds left "running" by a previous server stop
console.log(`\n  VibeHard alpha → http://localhost:${server.port}\n  (sign up, add your LLM key, describe an app — the real pipeline runs)\n`);

// Close the durable-DB connection cleanly on shutdown (container stop/redeploy sends SIGTERM).
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} received — closing the durable-DB connection…`);
  server.stop();
  await platformDb.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
