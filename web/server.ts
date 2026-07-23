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
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { Platform, StripeBillingProvider, StripeClient } from "../src/platform/index.ts";
import { PgBuildProgressStore, type ActiveBuild, type BuildProgressStore, type BuildRecord } from "../src/platform/build-store.ts";
import { PgSecretsTokenStore } from "../src/build-substrate/secrets-token-store.ts";
import { authorizeRecordRequest, PgDispatchTokenStore } from "../src/build-substrate/dispatch-token-store.ts";
import { PgEscalationSink, PgRecordStore, PgSecretsStore } from "../src/platform/pg-store.ts";
import { PgFleetStore, type Candidate } from "../src/fleet/store.ts";
import type { BackendSecrets, DeploymentRecord } from "../src/substrate/types.ts";
import { PgBuildLogStore } from "../src/build-substrate/build-log-store.ts";
import { E2BBuildWorker, readPlatformBuildSha, realE2BSandboxFactory, type BuildMode } from "../src/build-substrate/build-worker.ts";
import { TigrisWorkspaceStore } from "../src/build-substrate/workspace-store.ts";
import { localSpawnPipeline, e2bPipeline, type RunPipeline } from "../src/build-substrate/build-dispatcher.ts";
import { operatorLLMKey, type BuildEnvParts } from "../src/build-substrate/build-env.ts";
import { checkOpenRouterBudget } from "../src/platform/provider-budget.ts";
import { migrateLegacyUsersFile, PgUserStore, type UserRecord } from "../src/platform/user-store.ts";
import { migrateLegacyTenantFiles, PgTenantKvStore } from "../src/platform/tenant-kv.ts";
import { coerceSpec, decideRigor, llmInterviewer, llmIntake, reviewSpec, type DeployTarget, type InterviewTurn } from "../src/spec/index.ts";
import { isBlocking } from "../src/types.ts";
import { byoModelFactory, defaultModelFactory } from "../src/engine/bolt/driver.ts";
import { configForStage } from "../src/config/models.ts";
import { applyBillingDecision, decideBillingEvent, parseStripeEvent, verifyStripeSignature } from "../src/platform/billing-webhook.ts";
import { LocalEscalationSink, type EscalationTicket } from "../src/escalation/index.ts";
import { translateFindings, llmTranslator } from "../src/translate/index.ts";
import { requiredCredentialsForApp } from "../src/credentials/index.ts";
import { verifySentinel } from "../src/gate/index.ts";
import { llmFunctionalReviewer, summarize } from "../src/functest/functest.ts";
import { Orchestrator, llmClassifier, type Channel, type OutboundMessage, type ConfirmStore, type Intent } from "@vibehard/orchestrator";
import { realBuildTools } from "../src/orchestrator-glue/build-tools.ts";
import { validateSupabaseConnection, supabaseKeychainEntries, stripeConnectAuthUrl, exchangeStripeConnectCode, stripeKeychainEntries } from "../src/connectors/index.ts";
import { isSafeAppName } from "../src/util/safe-path.ts";
import { normalizeSteering, STEERING_FILE, MAX_STEERING_BYTES } from "../src/steering/steering.ts";
import { suggestSteering } from "../src/steering/suggest.ts";
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
// EPIC #33 (closing the 2026-07-03 gap): active-build/build-history tracking rides the SAME durable
// `sql` connection platform.ts already proved works for tenants — Platform.open() always returns a
// working sql (managed Postgres via DATABASE_URL, or embedded disk-persisted pglite locally), so
// this can be unconditional, same as `platform` itself (FileBuildProgressStore, the local-only
// fallback, stays available in build-store.ts for callers that don't go through Platform.open).
const buildStore: BuildProgressStore = new PgBuildProgressStore(platformDb.sql);
// EPIC #33 (second 2026-07-03 gap): the email → tenantId identity map ALSO lived in a local
// users.json — the builds survived a restart in Postgres but the pointer to them didn't, so the
// auth seam minted returning users a fresh tenant and everything they owned looked gone. Identity
// now rides the same durable sql; any surviving legacy file is imported once at boot (Pg wins).
const userStore = new PgUserStore(platformDb.sql);
// EPIC #33 (final sweep): the per-tenant LLM key, integrations keychain, and orchestrator inbox
// were the last file-local tenant state — wiped on every deploy like the two gaps before them.
// Secret values are stored as the SAME AES-256-GCM ciphertext the files held; plaintext never
// touches the table.
const tenantKv = new PgTenantKvStore(platformDb.sql);
const seenBillingEvents = new Set<string>(); // processed Stripe event ids → drop replays (idempotency)
// build-substrate W5b (SPEC decision #8): a BuildWorker sandbox has no direct DB/tenantKv access —
// it exchanges the single-use token minted at dispatch time for its env via /api/internal/build-env
// below. Not yet minted or dispatched from anywhere (that's W4's dispatcher); this is the seam +
// callback endpoint it will call, wired now so W4 has something real to mint against.
const secretsTokenStore = new PgSecretsTokenStore(platformDb.sql);
// build-substrate W5a/W6: the reusable per-dispatch token a BuildWorker's checkpoint script pings
// once per autofix round — refreshes the heartbeat and reports whether a stop was requested.
const dispatchTokenStore = new PgDispatchTokenStore(platformDb.sql);

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
// Durable via tenantKv (EPIC #33 final sweep) — the value in the table is the same AES-256-GCM
// ciphertext llm-key.enc used to hold.
async function saveKey(tenantId: string, key: string): Promise<void> {
  await tenantKv.put(tenantId, "llm-key", encrypt(key));
}
async function loadKey(tenantId: string): Promise<string | null> {
  const enc = await tenantKv.get(tenantId, "llm-key");
  return enc ? decrypt(enc) : null;
}

// ── integrations keychain (backlog #5): a tenant's third-party keys (Stripe, OAuth, email…),
//    saved once (encrypted, each value separately) and injected into every build/ship subprocess. ──
// Durable via tenantKv rows `integration:<name>` (EPIC #33 final sweep) — each value stored as
// the same per-value ciphertext integrations.json used to hold.
async function loadIntegrations(tenantId: string): Promise<Record<string, string>> {
  const enc = await tenantKv.list(tenantId, "integration:");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(enc)) {
    const plain = decrypt(v);
    if (plain !== null) out[k] = plain; // skip a value we can't decrypt
  }
  return out;
}
async function saveIntegration(tenantId: string, key: string, value: string): Promise<void> {
  await tenantKv.put(tenantId, `integration:${key}`, encrypt(value));
}
async function integrationKeys(tenantId: string): Promise<string[]> {
  return Object.keys(await tenantKv.list(tenantId, "integration:"));
}

/** On boot, no build subprocess is alive, so any record still marked "running" is stale (the server
 *  died mid-build). Flip it to "paused" so it shows as resumable instead of falsely in-progress.
 *  EPIC #33: now reads `buildStore.listTenantIds()` (durable Postgres) instead of enumerating a
 *  local directory — this is the exact sweep that was silently finding nothing after a restart,
 *  since the local ~/.vibehard/tenants tree it used to scan was wiped along with everything else. */
async function sweepStaleRunning(): Promise<void> {
  for (const id of await buildStore.listTenantIds()) {
    try {
      const ab = await buildStore.getActive(id);
      if (ab?.status === "running") await buildStore.setActive(id, { ...ab, status: "paused" });
      const builds = await buildStore.listBuilds(id);
      for (const b of builds) {
        if (b.status === "running") await buildStore.patchBuild(id, b.app, { status: "paused" });
      }
    } catch {
      /* skip a tenant we can't read */
    }
  }
}

// build-substrate W6: heartbeat-based staleness detection for a BuildWorker-dispatched build —
// distinct from sweepStaleRunning's boot-time "this process just started" inference, which
// becomes wrong in both directions once the build subprocess isn't the web process's own child
// (a worker can die silently while the web tier keeps running for weeks; a web-tier redeploy no
// longer implies anything about a live worker). Runs periodically, not just at boot. ONLY applies
// to builds that actually set workerHeartbeatAt (i.e. dispatched via BuildWorker) — a locally-
// spawned build (today's default path) never sets it and is correctly exempted, unaffected.
// 20 min, not 10 (found live 2026-07-23): the heartbeat only refreshes once per COMPLETED
// autofix round (checkpointHook, called from onRoundComplete) — it is NOT pinged mid-round. A
// single round's fixer call is bounded by the streaming driver's own overall cap (15 min per
// attempt, VIBEHARD_STREAM_OVERALL_MS) and can retry once whole (applyFixWithRetry), so a
// legitimately slow — but very much alive — round can easily exceed 10 minutes between pings.
// Confirmed live: a build was marked "error" by this sweep while its E2B sandbox was still
// genuinely running (verified directly via `e2b sandbox logs` — the fix process was still
// executing, well inside its 1h lifetime) and pinged again minutes later, moving the build
// forward past the point this sweep had already killed it. 20 min comfortably clears the
// driver's own 15-min single-attempt bound while still catching an ACTUALLY dead worker
// promptly relative to autoFix's own 35-min outer ceiling.
const ORPHAN_HEARTBEAT_STALE_MS = 20 * 60_000; // no ping in 20min ⇒ the worker is presumed dead
async function sweepOrphanedWorkers(): Promise<void> {
  for (const id of await buildStore.listTenantIds()) {
    try {
      const ab = await buildStore.getActive(id);
      if (ab?.status !== "running" || !ab.workerHeartbeatAt) continue;
      const age = Date.now() - new Date(ab.workerHeartbeatAt).getTime();
      if (age > ORPHAN_HEARTBEAT_STALE_MS) {
        await buildStore.setActive(id, { ...ab, status: "error" });
        await buildStore.patchBuild(id, ab.app, { status: "error" });
        console.error(`  orphan sweep: tenant ${id} app ${ab.app} — no worker heartbeat in ${Math.round(age / 60_000)}min, marked error`);
      }
    } catch {
      /* skip a tenant we can't read — never let one bad record wedge the sweep */
    }
  }
}

// ── users (email → {tenantId, name, hash}) — durable via userStore (platform_users) ────────────
// The record shape lives in user-store.ts; USERS (the legacy users.json path) is kept only as the
// one-time boot-import source below.
type User = UserRecord;

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
async function userOf(req: Request): Promise<{ email: string; user: User } | null> {
  const email = sessionEmail(cookieOf(req));
  const u = email ? await userStore.get(email) : null;
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
    return ALLOWED_HOSTS.has(new URL(origin).host);
  } catch {
    return false;
  }
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

// ── the marketing site (web/landing — TRACKED, ships in the image; the old untracked
//    landing/ draft was .dockerignore'd, which is why the root 404'd on launch day) ──
const LANDING_DIR = join(import.meta.dir, "landing");
async function serveStatic(path: string): Promise<Response> {
  const rel = path === "/" ? "index.html" : decodeURIComponent(path.replace(/^\//, ""));
  if (rel.includes("..")) return new Response("forbidden", { status: 403 });
  const f = Bun.file(join(LANDING_DIR, rel));
  return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
}

// ── social login (Google + GitHub OAuth) ────────────────────────────────────────
const BASE_URL = process.env.BASE_URL || `http://localhost:${Number(process.env.PORT) || 4100}`;
// Every origin this app is legitimately served from: BASE_URL plus VIBEHARD_EXTRA_ORIGINS
// (comma-separated). Used by BOTH the Clerk azp check and the sameOrigin CSRF guard — the app
// answers on several hostnames in prod (vibehard.ai, www, *.fly.dev), and validating against
// BASE_URL alone rejects every session from the other hostnames (the launch-day login loop).
const ALLOWED_ORIGINS: string[] = [BASE_URL, ...(process.env.VIBEHARD_EXTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
const ALLOWED_HOSTS = new Set(ALLOWED_ORIGINS.map((o) => { try { return new URL(o).host; } catch { return ""; } }).filter(Boolean));

// build-substrate W4: the ONE place that decides where a build's actual compute runs. Local
// subprocess by default (today's exact behavior, unchanged) — VIBEHARD_BUILD_WORKER=e2b is the
// deliberate opt-in switch to dispatch onto an E2B BuildWorker sandbox instead. Fails CLOSED
// (loud, at boot) rather than silently falling back to local if e2b is requested but
// misconfigured — the same posture as this codebase's other fail-closed config (e.g.
// VIBEHARD_SECRETS_KEY having no hardcoded default).
const buildLogStore = new PgBuildLogStore(platformDb.sql);
function buildRunPipeline(): RunPipeline {
  if (process.env.VIBEHARD_BUILD_WORKER !== "e2b") return localSpawnPipeline(join(import.meta.dir, ".."));
  const apiKey = process.env.E2B_API_KEY;
  const bucket = process.env.BUCKET_NAME;
  if (!apiKey || !bucket) {
    throw new Error("VIBEHARD_BUILD_WORKER=e2b requires E2B_API_KEY and BUCKET_NAME to both be set");
  }
  return e2bPipeline({
    worker: new E2BBuildWorker({
      createSandbox: realE2BSandboxFactory(apiKey),
      workspaceStore: new TigrisWorkspaceStore(bucket),
      buildLogStore,
      // In-process: secretsTokenStore lives in THIS same server, so fetchEnv reads it directly
      // rather than making a self-referential HTTP call to /api/internal/build-env — that
      // endpoint exists for a future dispatcher that runs as a separate process/service; here,
      // going through it would just be an unnecessary network hop to itself.
      fetchEnv: async (token) => (await secretsTokenStore.consume(token)) ?? {},
      templateId: "vibehard-build-worker",
      platformBaseUrl: BASE_URL,
      // Version handshake (2026-07-18, acceptance test 0/3): refuse to dispatch to a worker
      // template built from a different commit than this server — the template drifted a week
      // stale, silently, and every real user build ran old code. readPlatformBuildSha() reads
      // the image's own baked stamp; scripts/release.sh keeps both images stamped in lockstep.
      platformSha: readPlatformBuildSha(),
    }),
    buildLogStore,
    mintSecretsToken: (env) => secretsTokenStore.mint(env),
    mintStopCheckToken: (tenantId, app) => dispatchTokenStore.mint(tenantId, app),
  });
}
const runPipeline: RunPipeline = buildRunPipeline();

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
    const rs = await clerkClient.authenticateRequest(req, { authorizedParties: ALLOWED_ORIGINS });
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
      findTenantByEmail: async (email) => (await userStore.get(email))?.tenantId ?? null,
      createTenant: async (email, name, id) => {
        const t = await platform.signUp(name);
        await userStore.put(email, { tenantId: t.id, name, hash: `clerk:${id}` }); // hash marks a Clerk-owned account (no password)
        return t.id;
      },
      getName: async (id) => {
        const u = await getUserOnce();
        return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || null;
      },
    });
    if (!resolved) return null;
    const user = await userStore.get(resolved.email);
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
  const existing = await userStore.get(email);
  if (!existing) {
    const tenant = await platform.signUp(name || email.split("@")[0]!);
    await userStore.put(email, { tenantId: tenant.id, name: name || email, hash: `oauth:${provider}` });
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
    for (const [k, v] of Object.entries(stripeKeychainEntries(tokens))) await saveIntegration(tenantId, k, v);
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

/** The app's held-for-review UI tells the customer "an engineer has been notified" — this is what
 *  makes that sentence true until the full reviewer layer (EPIC #39) exists: every held build
 *  emails the operator (VIBEHARD_OPERATOR_EMAIL) with enough context to open the queue ticket.
 *  Best-effort and fire-and-forget: a notification failure must never affect the build's outcome,
 *  and it always leaves a server-log line as the fallback trail. */
async function notifyOperatorHeld(info: { tenantId: string; app: string; prompt: string; ticket?: string }): Promise<void> {
  const line = `[held] tenant ${info.tenantId} app ${info.app}${info.ticket ? ` ticket ${info.ticket}` : ""} — "${info.prompt.slice(0, 120)}"`;
  console.log(line);
  const to = process.env.VIBEHARD_OPERATOR_EMAIL;
  const key = process.env.RESEND_API_KEY;
  if (!to || !key) return; // log-only until both are configured
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "VibeHard <onboarding@resend.dev>",
        to,
        subject: `Build held for review — ${info.app}`,
        html: `<p>A build was held by the gates and needs a human decision.</p><ul><li><b>App:</b> ${info.app}</li><li><b>Tenant:</b> ${info.tenantId}</li>${info.ticket ? `<li><b>Ticket:</b> ${info.ticket}</li>` : ""}<li><b>Prompt:</b> ${info.prompt.slice(0, 300).replace(/</g, "&lt;")}</li></ul><p>Findings are on the tenant's dashboard ("see what's flagged") and in the escalation queue.</p>`,
      }),
    });
  } catch {
    /* the console line above is the fallback trail */
  }
}

// ── build control: track the running subprocess per tenant (for Stop) + persist the active build
//    so a stopped build can be resumed, even across a page reload — durably (EPIC #33), via
//    `buildStore` above, not local files (ActiveBuild/BuildRecord types live in build-store.ts) ──
// build-substrate W4: widened from Map<string, Bun.Subprocess> to a minimal kill()-only shape —
// a Bun.Subprocess still satisfies this structurally, so every existing read site (isBuildRunning's
// .has(), /api/build/stop's .get()?.kill()) is unchanged; only runStep's own local-path write
// site (registerKill) needed a shape that doesn't require a real Bun.Subprocess.
const running = new Map<string, { kill: () => void }>();
const stopFlags = new Set<string>();
const tenantDir = (tenantId: string) => join(ROOT, "tenants", tenantId.replace(/[^a-zA-Z0-9_-]/g, "_"));

/** What the persisted PRD (.vibehard/spec.json) says this app's deploy target is — "hosted-app"
 *  (default) unless the build was for a local CLI/script (deployTarget: "downloadable-tool"). Read
 *  the same way verify.ts's readRigor/readDeployTarget do: coerceSpec on the raw JSON, so a
 *  missing/malformed file conservatively reads as "hosted-app" (never falsely offers a download). */
function deployTargetForApp(tenantId: string, app: string): DeployTarget {
  try {
    const p = join(tenantDir(tenantId), "apps", app, ".vibehard", "spec.json");
    if (!existsSync(p)) return "hosted-app";
    return coerceSpec(JSON.parse(readFileSync(p, "utf8"))).deployTarget;
  } catch {
    return "hosted-app";
  }
}

/** Zip a tenant app's workspace for download (deployTarget: "downloadable-tool" — there's no
 *  hosted URL, so this IS how a gate-passed build reaches the user). Excludes `.git/` and
 *  `node_modules/` (regenerable from package.json — don't ship it) and `.env` (kept as
 *  `.env.example` so the user still sees what to fill in). credentials/index.ts's NEVER_INJECT /
 *  AUTO_PROVIDED sets classify which ENV VAR NAMES are sensitive for build-time injection into a
 *  running app; they don't apply to file selection here — no real secret value is ever written
 *  into any OTHER file in the workspace, so excluding `.env` wholesale is the whole mitigation. */
function zipWorkspace(workspace: string, app: string): Buffer {
  const tmp = mkdtempSync(join(tmpdir(), "vibehard-export-"));
  try {
    const zipPath = join(tmp, `${app}.zip`);
    const zip = Bun.spawnSync(
      ["zip", "-r", "-q", zipPath, ".", "-x", ".git/*", ".git", "node_modules/*", "node_modules", ".env"],
      { cwd: workspace, stdout: "pipe", stderr: "pipe" },
    );
    if ((zip.exitCode ?? 1) !== 0) {
      throw new Error(`zip exited ${zip.exitCode} — ${(zip.stderr?.toString() || zip.stdout?.toString() || "unknown error").trim()}`);
    }
    return readFileSync(zipPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // best-effort cleanup of the scratch zip
  }
}

/** Whether a build is already running for `tenantId` — checked before every route that would
 *  spawn one. `running` alone is NOT enough: it's an in-process Map, and this server runs on
 *  MULTIPLE Fly machines behind one load balancer (min_machines_running = 2, see fly.toml) —
 *  each machine only knows about builds IT personally spawned. A request that lands on a
 *  DIFFERENT machine than the one already running a build for that tenant sailed straight
 *  past the "already running" 409 and started a genuinely concurrent second build (found live
 *  2026-07-07: a customer's second "Build it" click "started the whole process over" — the
 *  first build was very likely still running, just on the other machine). buildStore is
 *  Postgres-backed (EPIC #33) — the one thing both machines actually agree on — so it's the
 *  real guard; `running` stays for what it can uniquely do (holding the actual Bun.Subprocess
 *  handle so /api/build/stop can signal it on ITS OWN machine). */
async function isBuildRunning(tenantId: string): Promise<boolean> {
  if (running.has(tenantId)) return true;
  return (await buildStore.getActive(tenantId))?.status === "running";
}

/** Whole-machine, cross-tenant concurrency cap (EPIC #32 follow-up — found via dogfooding
 *  2026-07-09: nothing bounded how many DIFFERENT tenants could pile up spawning builds — each
 *  its own heavy subprocess (npm installs, security scanners, LLM streaming) — on this ONE
 *  shared host at once. `isBuildRunning` only stops the SAME tenant from double-submitting; it
 *  says nothing about 10 different tenants all clicking "build" in the same minute. Backed by
 *  `buildStore.countRunning()` (the shared Postgres store, not an in-process counter) for the
 *  same reason `isBuildRunning` had to move off the local `running` Map: this runs on multiple
 *  Fly machines behind one load balancer, so any local count would only ever see this machine's
 *  own builds. Configurable so ops can raise it as the platform scales past one machine. */
const MAX_CONCURRENT_BUILDS = Number(process.env.VIBEHARD_MAX_CONCURRENT_BUILDS) || 4;
async function atBuildCapacity(): Promise<boolean> {
  return (await buildStore.countRunning()) >= MAX_CONCURRENT_BUILDS;
}

// ── orchestrator: the conversational owner of a build (the chat panel's backend) ───────────
type InboxMsg = { at: number; kind: OutboundMessage["kind"]; text: string };
// Durable via tenantKv rows `inbox:<app>` (EPIC #33 final sweep) — plain JSON, not secret.
async function readInbox(tenantId: string, app: string): Promise<InboxMsg[]> {
  try {
    const raw = await tenantKv.get(tenantId, `inbox:${app}`);
    return raw ? (JSON.parse(raw) as InboxMsg[]) : [];
  } catch {
    return [];
  }
}
async function appendInbox(tenantId: string, app: string, m: OutboundMessage): Promise<void> {
  const list = await readInbox(tenantId, app);
  list.push({ at: Date.now(), kind: m.kind, text: m.text });
  await tenantKv.put(tenantId, `inbox:${app}`, JSON.stringify(list.slice(-200)));
}
// Durable via tenantKv rows `confirm:<app>` (closes a real bug on the multi-machine web tier:
// a "ship" proposal and its "yes" confirmation can be routed to different machines, each with
// its own in-process Orchestrator — without this, the second machine's fresh instance has no
// memory of the pending confirm and silently reclassifies "yes" as an unrelated message).
class TenantKvConfirmStore implements ConfirmStore {
  constructor(private readonly tenantId: string, private readonly app: string) {}
  async get(): Promise<Intent | null> {
    const raw = await tenantKv.get(this.tenantId, `confirm:${this.app}`);
    return (raw as Intent | null) || null;
  }
  async set(intent: Intent | null): Promise<void> {
    await tenantKv.put(this.tenantId, `confirm:${this.app}`, intent ?? "");
  }
}
// one orchestrator per (tenant, app), cached per-process purely as a perf/object-reuse
// optimization — NOT relied on for correctness: the confirm state itself is durable (above),
// so a cache miss (different machine, or this process restarted) still behaves correctly.
const orchestrators = new Map<string, Orchestrator>();
async function getOrchestrator(tenantId: string, app: string): Promise<Orchestrator> {
  const key = `${tenantId}:${app}`;
  let o = orchestrators.get(key);
  if (!o) {
    const workspace = join(tenantDir(tenantId), "apps", app);
    const channel: Channel = { send: (m) => appendInbox(tenantId, app, m) };
    const byo = await loadKey(tenantId);
    const modelFactory = byo ? byoModelFactory(byo.startsWith("sk-ant-") ? { anthropicKey: byo } : { openaiKey: byo }) : undefined;
    // Chat-dispatched retry/ship marker capture — mirrors buildStream()'s own runStep onLog
    // scanning (::held/LIVE →), previously unset entirely here (THE BUG: a chat-dispatched
    // build's output went nowhere, so a held ticket or a live URL was never captured).
    let chatHeldTicket: string | undefined;
    let chatLiveUrl: string | undefined;
    const tools = realBuildTools(workspace, runPipeline, {
      tenantId,
      app,
      // THE BUG THIS CLOSES: retry()/ship() previously had no concurrency guard at all — a chat
      // "retry" while an SSE-driven buildStream() was mid-flight could dispatch a second,
      // concurrent cli.ts run against the same workspace. Same checks buildStream()'s own two
      // HTTP call sites already use.
      guard: async () => {
        if (await isBuildRunning(tenantId)) return 'a build is already running — say "status" to check, or wait for it to finish';
        if (await atBuildCapacity()) return "the platform is at capacity right now — please try again in a few minutes";
        return null;
      },
      onDispatchStart: async () => {
        chatHeldTicket = undefined;
        chatLiveUrl = undefined;
        await buildStore.patchActive(tenantId, { status: "running" });
        await buildStore.patchBuild(tenantId, app, { status: "running" });
      },
      onLog: (ln) => {
        const h = ln.match(/::held (\S+)/);
        if (h) {
          chatHeldTicket = h[1];
          return;
        }
        const u = ln.match(/LIVE → (\S+)/);
        if (u) chatLiveUrl = u[1];
      },
      onRetryDone: (ok) => {
        const status = ok ? "paused" : "blocked"; // fixed-but-not-shipped has no dedicated status; "paused" (stopped, resumable) is the closest existing fit
        void buildStore.patchActive(tenantId, { status });
        void buildStore.patchBuild(tenantId, app, { status, ...(chatHeldTicket ? { ticket: chatHeldTicket } : {}) });
        if (status === "blocked") void notifyOperatorHeld({ tenantId, app, prompt: "(chat retry)", ticket: chatHeldTicket });
        channel.send(
          ok
            ? { kind: "done", text: '✅ The build landed clean — all gates pass. Say "ship" when you want to deploy.' }
            : {
                kind: "error",
                text: chatHeldTicket ? `🛑 Held for review (${chatHeldTicket}). Say "why" for detail.` : '🛑 It stopped again. Say "why" and I\'ll tell you the blocker.',
              },
        );
      },
      onRetryHeartbeat: (_dir, minutes) =>
        channel.send({ kind: "info", text: `Still working — the fix loop has been running about ${minutes} minute(s). I'll message you the moment it lands.` }),
      onShipDone: (ok) => {
        const status = ok ? "live" : "deploy-failed";
        void buildStore.patchActive(tenantId, { status });
        void buildStore.patchBuild(tenantId, app, { status, ...(chatLiveUrl ? { url: chatLiveUrl } : {}) });
        channel.send(
          ok
            ? { kind: "done", text: chatLiveUrl ? `🚀 Shipped → ${chatLiveUrl}` : "🚀 Shipped." }
            : { kind: "error", text: '🛑 Deploy failed. Say "why" for detail.' },
        );
      },
    });
    o = new Orchestrator(
      tools,
      channel,
      llmClassifier({ modelFactory: modelFactory ?? defaultModelFactory, config: configForStage("functest") }),
      new TenantKvConfirmStore(tenantId, app),
    );
    orchestrators.set(key, o);
  }
  return o;
}

// /api/spec-preview faucet state — in-memory like the session store (durable-state EPIC owns the rest).
const specPreviewHits = new Map<string, number[]>(); // ip → timestamps within the hour window
let specPreviewDay = "";
let specPreviewDayCount = 0;

const server = Bun.serve({
  port: Number(process.env.PORT) || 4000,
  idleTimeout: 240, // builds stream for minutes
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // "/" deliberately NOT here: the root is the marketing site (serveStatic fallthrough below);
    // the product lives at /app.
    // no-store: the app shell inlines all its JS — a browser heuristically caching it keeps running
    // PRE-DEPLOY code after a fix ships (last night's SSE-reconnect storm outlived its own fix by
    // five hours in an open tab). The page is one small file; always fetch it fresh.
    if (path === "/app" || path === "/reset") return new Response(Bun.file(APP_HTML), { headers: { "cache-control": "no-store" } });
    if (path === "/auth/stripe/connect" || path === "/auth/stripe/callback") return handleStripeConnect(req, url, path);
    if (path.startsWith("/auth/")) return handleOAuth(url, path);

    // build-substrate W5b: a BuildWorker sandbox calls back here with the single-use token it was
    // dispatched with to fetch its env. Deliberately NOT session/cookie-authenticated — the caller
    // is a sandbox, not a browser; the token itself IS the credential (opaque, single-use,
    // short-lived, minted server-side only). A bad/replayed/unknown/expired token gets a bare 404
    // — never distinguish "wrong token" from "already used" from "expired" in the response, so a
    // caller can't use the error shape to fish for which case they hit.
    if (path === "/api/internal/build-env" && req.method === "POST") {
      let token: unknown;
      try {
        ({ token } = await req.json());
      } catch {
        return json({ error: "invalid request body" }, 400);
      }
      if (typeof token !== "string" || !token) return json({ error: "invalid request body" }, 400);
      const env = await secretsTokenStore.consume(token);
      if (!env) return json({ error: "not found" }, 404);
      return json({ env });
    }

    // build-substrate W5a/W6: a BuildWorker's checkpoint script calls this once per autofix
    // round via its (reusable, non-single-use) dispatch token — refreshes the durable heartbeat
    // and reports whether the operator asked to stop. Same "bad token → bare 404" posture as
    // build-env above; same reasoning (opaque token IS the credential, no session cookie).
    if (path === "/api/internal/build-checkpoint-ping" && req.method === "POST") {
      let token: unknown;
      try {
        ({ token } = await req.json());
      } catch {
        return json({ error: "invalid request body" }, 400);
      }
      if (typeof token !== "string" || !token) return json({ error: "invalid request body" }, 400);
      const resolved = await dispatchTokenStore.resolve(token);
      if (!resolved) return json({ error: "not found" }, 404);
      const active = await buildStore.getActive(resolved.tenantId);
      // No active build for this (tenantId, app) anymore, or it's since moved on to a DIFFERENT
      // app — the platform no longer considers this dispatch's build "the one running" (e.g. a
      // previous crash already flipped it via sweepOrphanedWorkers below). Nothing to keep this
      // worker running for — tell it to stop rather than silently doing nothing.
      if (!active || active.app !== resolved.app) return json({ stopRequested: true });
      await buildStore.patchActive(resolved.tenantId, { workerHeartbeatAt: new Date().toISOString() });
      return json({ stopRequested: active.stopRequested === true });
    }

    // build-substrate: the sandboxed `ship`'s ONLY durable read/write of its own DeploymentRecord
    // (src/substrate/record-client.ts). THE BUG THIS CLOSES (found live 2026-07-19, acceptance
    // test prompt C): without this, every sandboxed ship fell back to a local file that never
    // survives the sandbox's teardown, so it could never tell a redeploy from a first deploy —
    // it re-provisioned a BRAND NEW Supabase project every single time, silently abandoning the
    // previous one (data loss) and eventually exhausting the org's project quota. Same auth
    // posture as build-checkpoint-ping (reusable dispatch token, bearer header here since GET/
    // DELETE have no body; bad/wrong-app token → bare 404, never 403 — see authorizeRecordRequest).
    if (path === "/api/internal/deployment-record") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const resolved = token ? await dispatchTokenStore.resolve(token) : null;
      const auth = authorizeRecordRequest(resolved, url.searchParams.get("app"));
      if (!auth.ok) return json({ error: "not found" }, 404);
      const records = new PgRecordStore(platformDb.sql, auth.tenantId);
      const app = url.searchParams.get("app")!; // authorizeRecordRequest already proved this is non-null and matches the token's own app
      if (req.method === "GET") return json({ record: await records.get(app) });
      if (req.method === "DELETE") {
        await records.remove(app);
        return json({ ok: true });
      }
      if (req.method === "PUT") {
        let record: unknown;
        try {
          ({ record } = await req.json());
        } catch {
          return json({ error: "invalid request body" }, 400);
        }
        if (!record || typeof record !== "object" || (record as DeploymentRecord).app !== app) {
          return json({ error: "record.app must match the ?app= query param" }, 400);
        }
        await records.put(record as DeploymentRecord);
        return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // build-substrate: the sandboxed `ship`'s ONLY durable read/write of a REUSED backend's
    // connection secrets (src/substrate/secrets-client.ts) — direct sibling of
    // deployment-record above; read that route's comment first. THE BUG THIS CLOSES (found live
    // 2026-07-19, acceptance test prompt C, three ship attempts in a row): the record-store fix
    // made projectRef/appliedMigrations durable, but ensureProject's REUSE path also needs the
    // FULL connection (url/anonKey/serviceKey/dbHost/dbPassword) — which had the IDENTICAL
    // non-durability defect, so every redeploy silently probed an empty '' URL for the entire
    // live-RLS retry budget (~9.5 minutes wasted, 3 tables × ~190s each, every single time). Same
    // auth posture, same encrypted-at-rest store (PgSecretsStore) newly exposed over HTTP instead
    // of unused by any sandboxed caller.
    if (path === "/api/internal/backend-secrets") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const resolved = token ? await dispatchTokenStore.resolve(token) : null;
      const auth = authorizeRecordRequest(resolved, url.searchParams.get("app"));
      if (!auth.ok) return json({ error: "not found" }, 404);
      const secretsStore = new PgSecretsStore(platformDb.sql, process.env.VIBEHARD_SECRETS_KEY ?? "", auth.tenantId);
      const app = url.searchParams.get("app")!; // authorizeRecordRequest already proved this is non-null and matches the token's own app
      if (req.method === "GET") return json({ secrets: await secretsStore.get(app) });
      if (req.method === "DELETE") {
        await secretsStore.remove(app);
        return json({ ok: true });
      }
      if (req.method === "PUT") {
        let secrets: unknown;
        try {
          ({ secrets } = await req.json());
        } catch {
          return json({ error: "invalid request body" }, 400);
        }
        if (!secrets || typeof secrets !== "object" || typeof (secrets as BackendSecrets).url !== "string") {
          return json({ error: "invalid secrets body" }, 400);
        }
        await secretsStore.put(app, secrets as BackendSecrets);
        return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // build-substrate: the sandboxed build's ONLY durable read/write of its own escalation ticket
    // (src/escalation/http-client.ts) — third sibling of deployment-record/backend-secrets above;
    // read deployment-record's comment first. THE BUG THIS CLOSES (found live 2026-07-20,
    // acceptance test prompt C, second retry): `runAutoFixAndReport` opens a held build's ticket
    // via LocalEscalationSink, wherever the gate/fix loop runs — in production, an ephemeral E2B
    // sandbox with no durable state of its own. The ticket file landed on the sandbox's disk and
    // was destroyed the instant the build held; `/api/held` then asked the PLATFORM's own local
    // queue for that id and found nothing. Every E2B-dispatched held build was therefore silently
    // unexplainable — "held by the gates" with zero findings shown. Same auth posture as the two
    // siblings (reusable dispatch token, bad/wrong-app token → bare 404). Scoped narrower than the
    // full EscalationSink on purpose: only GET/PUT of exactly one ticket id, matching what a build
    // sandbox's own open()/get() ever need — claim/resolve/list are reviewer actions and stay off
    // this endpoint entirely (see http-client.ts's header comment).
    if (path === "/api/internal/escalation-ticket") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const resolved = token ? await dispatchTokenStore.resolve(token) : null;
      const auth = authorizeRecordRequest(resolved, url.searchParams.get("app"));
      if (!auth.ok) return json({ error: "not found" }, 404);
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id required" }, 400);
      const tickets = new PgEscalationSink(platformDb.sql, auth.tenantId);
      if (req.method === "GET") return json({ ticket: await tickets.get(id) });
      if (req.method === "PUT") {
        let ticket: unknown;
        try {
          ({ ticket } = await req.json());
        } catch {
          return json({ error: "invalid request body" }, 400);
        }
        if (!ticket || typeof ticket !== "object" || (ticket as EscalationTicket).id !== id) {
          return json({ error: "ticket.id must match the ?id= query param" }, 400);
        }
        await tickets.put(ticket as EscalationTicket);
        return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // build-substrate: a sandboxed build's read of the platform-wide learned conventions
    // (src/fleet/http-client.ts). Fourth sibling of the three above — but UNLIKE those three,
    // fleet data is deliberately global, not scoped to one tenant/app (see fleet/store.ts's header
    // for why), so authorization here is just "does this token resolve at all" — any active
    // dispatch may read the shared conventions, there is no per-app data to leak. THE BUG THIS
    // CLOSES (found live 2026-07-20, sandbox-durability audit): fleet.ts's conventions lived at
    // `~/.vibehard/fleet/conventions.json` on WHATEVER machine ran the CLI — for an E2B sandbox,
    // an always-fresh, always-empty disk. Every build's codegen/architecture prompt silently ran
    // with ZERO learned conventions injected, no error, the entire time E2B dispatch has been live.
    if (path === "/api/internal/fleet-conventions" && req.method === "GET") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const resolved = token ? await dispatchTokenStore.resolve(token) : null;
      if (!resolved) return json({ error: "not found" }, 404);
      return json({ conventions: await new PgFleetStore(platformDb.sql).getConventions() });
    }

    // build-substrate: a sandboxed build's read+write of ONE fleet candidate (recordCandidate/
    // recordResolution, during the auto-fix loop) — same global-scope reasoning as
    // fleet-conventions above. THE BUG THIS CLOSES: candidates.json had the IDENTICAL defect —
    // every sandboxed build's "this gate failure recurred" counter reset to a fresh, empty file
    // every time, so the promotion threshold (3 independent builds) could never be reached; no
    // convention has been auto-promoted from a live E2B build since dispatch went live.
    if (path === "/api/internal/fleet-candidates") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const resolved = token ? await dispatchTokenStore.resolve(token) : null;
      if (!resolved) return json({ error: "not found" }, 404);
      const key = url.searchParams.get("key");
      if (!key) return json({ error: "key required" }, 400);
      const candidates = new PgFleetStore(platformDb.sql);
      if (req.method === "GET") return json({ candidate: await candidates.getCandidate(key) });
      if (req.method === "PUT") {
        let candidate: unknown;
        try {
          ({ candidate } = await req.json());
        } catch {
          return json({ error: "invalid request body" }, 400);
        }
        if (!candidate || typeof candidate !== "object" || (candidate as Candidate).key !== key) {
          return json({ error: "candidate.key must match the ?key= query param" }, 400);
        }
        await candidates.putCandidate(candidate as Candidate);
        return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }

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
      if (await userStore.get(email)) return json({ error: "an account with that email already exists" }, 409);
      const tenant = await platform.signUp(name || email.split("@")[0]!);
      await userStore.put(email, { tenantId: tenant.id, name: name || email, hash: await Bun.password.hash(password) });
      const token = setSession(email);
      return json({ ok: true, tenantId: tenant.id }, 200, { "set-cookie": `vh=${token}; Path=/; HttpOnly; SameSite=Lax` });
    }

    if (path === "/api/login" && req.method === "POST") {
      const { email, password } = (await req.json()) as { email?: string; password?: string };
      const key = (email ?? "").toLowerCase().trim();
      // audit2 C-6: throttle password guessing per account (in-memory; alpha single-process).
      if (key && loginThrottled(key)) return json({ error: "too many attempts — wait a few minutes and try again" }, 429);
      const u = email ? await userStore.get(email) : null;
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
      const u = email ? await userStore.get(email) : null;
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
      const u = await userStore.get(entry.email);
      if (!u) return json({ error: "that account no longer exists" }, 400);
      u.hash = await Bun.password.hash(password);
      await userStore.put(entry.email, u);
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
        hasKey: (await loadKey(auth.user.tenantId)) !== null,
        // Turnkey: the platform carries its own LLM key, so builds work with ZERO setup — a tenant's
        // own key (hasKey) is an optional override, not a prerequisite. The build child process
        // already inherits the operator key from process.env; this flag just tells the UI not to gate.
        turnkey: Boolean(process.env.OPENROUTER_API_KEY || process.env.OPENCODE_API_KEY || process.env.ANTHROPIC_API_KEY),
        // persistent project history (survives re-login); deployTarget merged in so the dashboard
        // can tell a downloadable-tool build apart from a hosted one (renderDownload vs "Shipped").
        builds: (await buildStore.listBuilds(auth.user.tenantId)).map((b) => ({ ...b, deployTarget: deployTargetForApp(auth.user.tenantId, b.app) })),
        activeBuild: await buildStore.getActive(auth.user.tenantId), // a running/paused build the dashboard can stop or resume
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
      await saveKey(auth.user.tenantId, k);
      return json({ ok: true });
    }

    if (path === "/api/billing/plans") {
      // Frontend needs plan name → priceId to start checkout, but only the reverse (priceId → plan)
      // is configured (that's what the webhook needs). Invert it here so the price IDs live in exactly
      // one place (VIBEHARD_STRIPE_PRICE_MAP) — the checkout buttons never hardcode a price ID.
      const planToPrice: Record<string, string> = {};
      for (const [priceId, plan] of Object.entries(PRICE_TO_PLAN)) planToPrice[plan] = priceId;
      return json({ configured: Boolean(stripeBilling), plans: planToPrice });
    }

    if (path === "/api/billing/checkout" && req.method === "POST") {
      if (!auth) return json({ error: "sign in first" }, 401);
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403); // audit3 D-2 CSRF
      if (!stripeBilling) return json({ error: "billing isn't configured" }, 503);
      const { priceId } = (await req.json()) as { priceId?: string };
      if (!priceId) return json({ error: "which plan? (priceId required)" }, 400);
      if (!(priceId in PRICE_TO_PLAN)) return json({ error: "unknown plan" }, 400); // only checkout for prices we actually map to a plan
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

    if (path === "/api/spec-preview" && req.method === "POST") {
      // THE FREE SAMPLE (landing hero): an anonymous visitor's first real artifact. One LLM pass
      // drafts the same Spec the pipeline starts from; deterministic reviewSpec grades readiness.
      // Unauthenticated by design, so it's guarded like a paid faucet: same-origin only, prompt
      // length cap, 3/hour per IP, and a global daily ceiling. It reads/writes NO tenant state.
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403);
      const { prompt } = (await req.json().catch(() => ({}))) as { prompt?: string };
      const idea = (prompt ?? "").trim();
      if (!idea) return json({ error: "describe the app first" }, 400);
      // 2026-07-06: was 600 — far too tight for a real description (more detail from the
      // customer only helps the drafted spec), and a hard reject with no client-side warning
      // meant a visitor could write a paragraph and just get bounced. 4000 is generous for an
      // anonymous, unauthenticated, zero-signup preview call while still bounding worst-case
      // cost; the rate limits below (3/hour/IP, 300/day) are the real abuse control, not length.
      if (idea.length > 4000) return json({ error: "keep it under 4000 characters for the free preview — plenty of room, we just cap it here" }, 400);
      const ip = req.headers.get("fly-client-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
      const now = Date.now();
      const hits = (specPreviewHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
      if (hits.length >= 3) return json({ error: "that's three free spec drafts this hour — create a free account to keep going" }, 429);
      const day = new Date().toISOString().slice(0, 10);
      if (day !== specPreviewDay) { specPreviewDay = day; specPreviewDayCount = 0; }
      if (specPreviewDayCount >= 300) return json({ error: "the drafting desk is at capacity today — create a free account to build" }, 429);
      hits.push(now);
      specPreviewHits.set(ip, hits);
      specPreviewDayCount++;
      try {
        const spec = await llmIntake()(idea, null);
        const gaps = reviewSpec(spec);
        return json({ spec, rigor: decideRigor(spec), ready: !gaps.some(isBlocking), gaps: gaps.filter(isBlocking).length });
      } catch {
        return json({ error: "the drafting desk hiccuped — try again in a minute" }, 503);
      }
    }

    if (path === "/api/intake/next" && req.method === "POST") {
      // grill-me INTERVIEW: one question at a time. Given the prompt + the Q&A so far, return the
      // next question (with a recommended answer) or {done:true}. Fail-safe: any error → done.
      if (!auth) return json({ error: "sign in first" }, 401);
      const { prompt, history } = (await req.json()) as { prompt?: string; history?: InterviewTurn[] };
      if (!prompt?.trim()) return json({ done: true });
      try {
        const byo = await loadKey(auth.user.tenantId);
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
      const rec = (await buildStore.listBuilds(auth.user.tenantId)).find((b) => b.app === app);
      if (!rec?.ticket) return json({ state: null, findings: [] });
      // Durable (Postgres) FIRST — where an E2B-dispatched build's ticket lands (via
      // httpEscalationSink → /api/internal/escalation-ticket; see that endpoint's header comment
      // for the bug this fixes). Fall back to the local queue for a LOCAL (non-E2B) dispatch,
      // which runs on this same box and has always written there durably enough (same disk as
      // this read) — unchanged behavior for that path.
      const ticket =
        (await new PgEscalationSink(platformDb.sql, auth.user.tenantId).get(rec.ticket)) ??
        (await new LocalEscalationSink(process.env.VIBEHARD_QUEUE_DIR ?? join(homedir(), ".vibehard", "queue")).get(rec.ticket));
      if (!ticket) return json({ state: null, findings: [] });
      // the dictionary handles the common cases synchronously; anything it can't place (source
      // === "generic") gets one bounded LLM pass so "held" is never a wall of "a reviewer can
      // confirm" — the tenant's own key if they have one, else the platform's.
      const byo = await loadKey(auth.user.tenantId);
      const modelFactory = byo ? byoModelFactory(byo.startsWith("sk-ant-") ? { anthropicKey: byo } : { openaiKey: byo }) : undefined;
      const explanations = await translateFindings(ticket.packet.items.map((it) => it.finding), llmTranslator({ modelFactory }));
      const findings = ticket.packet.items.map((it, i) => {
        const e = explanations[i]!;
        return { area: it.specialty, title: e.title, detail: e.detail, severity: it.finding.severity, file: it.finding.file };
      });
      return json({ state: ticket.state, claimedBy: ticket.claimedBy, ticket: ticket.id, findings });
    }

    if (path === "/api/orchestrator/message" && req.method === "POST") {
      // Inbound: a message to the build's orchestrator → a real action + a reply.
      if (!auth) return json({ error: "sign in first" }, 401);
      const { app, text } = (await req.json()) as { app?: string; text?: string };
      if (!app || !text?.trim()) return json({ error: "app and text required" }, 400);
      if (!(await buildStore.listBuilds(auth.user.tenantId)).some((b) => b.app === app)) return json({ error: "unknown build" }, 404);
      const reply = await (await getOrchestrator(auth.user.tenantId, app)).onMessage(text.trim());
      return json({ reply });
    }

    if (path === "/api/orchestrator/inbox") {
      // Outbound: proactive messages the orchestrator pushed (held, build-landed, …) since `since`.
      if (!auth) return json({ messages: [] });
      const app = url.searchParams.get("app");
      const since = Number(url.searchParams.get("since") ?? 0);
      // C1: `app` is a path segment — reject traversal before it reaches readInbox's join().
      if (!app || !isSafeAppName(app)) return json({ messages: [] });
      return json({ messages: (await readInbox(auth.user.tenantId, app)).filter((m) => m.at > since) });
    }

    if (path === "/api/functest") {
      // #11: LLM QA — does the built app implement the features the spec captured? (advisory)
      if (!auth) return json({ checks: [] });
      const app = url.searchParams.get("app");
      const rec = app ? (await buildStore.listBuilds(auth.user.tenantId)).find((b) => b.app === app) : null;
      if (!rec) return json({ checks: [] });
      const workspace = join(tenantDir(auth.user.tenantId), "apps", app!);
      const specPath = join(workspace, ".vibehard", "spec.json");
      if (!existsSync(specPath)) return json({ checks: [] });
      try {
        const spec = JSON.parse(readFileSync(specPath, "utf8")) as { features?: string[] };
        const features = Array.isArray(spec.features) ? spec.features : [];
        if (!features.length) return json({ checks: [] });
        const byo = await loadKey(auth.user.tenantId);
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
      await saveIntegration(auth.user.tenantId, key, value.trim());
      return json({ ok: true });
    }

    if (path === "/api/steering" && req.method === "GET") {
      // The tenant's standing business rules (EPIC #54) — plain text, one rule per line, not secret.
      if (!auth) return json({ error: "sign in first" }, 401);
      const raw = (await tenantKv.get(auth.user.tenantId, "steering")) ?? "";
      const { kept, dropped } = normalizeSteering(raw);
      return json({ rules: kept.join("\n"), dropped });
    }

    if (path === "/api/steering" && req.method === "POST") {
      // Save the rules. Normalization is the SAME function the prompt render uses, so what the UI
      // reports as kept/dropped is exactly what a build will and won't see — no drift possible.
      if (!auth) return json({ error: "sign in first" }, 401);
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403); // audit3 D-2 CSRF
      const { rules } = (await req.json()) as { rules?: string };
      if (typeof rules !== "string") return json({ error: "rules (string) required" }, 400);
      if (rules.length > MAX_STEERING_BYTES * 4) return json({ error: "steering text too large" }, 400);
      const { kept, dropped } = normalizeSteering(rules);
      await tenantKv.put(auth.user.tenantId, "steering", kept.join("\n"));
      return json({ ok: true, kept, dropped });
    }

    if (path === "/api/steering/suggest" && req.method === "POST") {
      // Propose candidate rules from the tenant's most recent build prompt (which carries the
      // folded grill-me answers). LLM proposes → normalizeSteering disposes → user confirms by
      // saving. Nothing here writes state.
      if (!auth) return json({ error: "sign in first" }, 401);
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403); // audit3 D-2 CSRF
      const builds = await buildStore.listBuilds(auth.user.tenantId);
      const latest = builds[0];
      if (!latest?.prompt) return json({ candidates: [] });
      const existing = (await tenantKv.get(auth.user.tenantId, "steering")) ?? "";
      const candidates = await suggestSteering(latest.prompt, existing);
      return json({ candidates });
    }

    if (path === "/api/connect/supabase" && req.method === "POST") {
      // Validated key-import wizard: PROVE the URL + anon + service keys against the live project,
      // then persist all three to the keychain. A wrong paste fails here, not silently at deploy.
      if (!auth) return json({ error: "sign in first" }, 401);
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403); // audit3 D-2 CSRF
      const { url: sbUrl, anonKey, serviceKey } = (await req.json()) as { url?: string; anonKey?: string; serviceKey?: string };
      const result = await validateSupabaseConnection({ url: sbUrl ?? "", anonKey: anonKey ?? "", serviceKey: serviceKey ?? "" });
      if (!result.ok) return json({ ok: false, checks: result.checks }, 400);
      for (const [k, v] of Object.entries(supabaseKeychainEntries({ url: sbUrl!, anonKey: anonKey!, serviceKey: serviceKey! }))) await saveIntegration(auth.user.tenantId, k, v);
      return json({ ok: true, ref: result.ref, checks: result.checks });
    }

    if (path === "/api/connect/status") {
      // Which connectors the tenant has wired (presence only — never the values) + which are offered.
      if (!auth) return json({ error: "sign in first" }, 401);
      const have = await integrationKeys(auth.user.tenantId);
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
      const rec = app ? (await buildStore.listBuilds(auth.user.tenantId)).find((b) => b.app === app) : null;
      if (!rec) return json({ required: [], have: [] });
      const required = requiredCredentialsForApp(join(tenantDir(auth.user.tenantId), "apps", app!));
      return json({ required, have: await integrationKeys(auth.user.tenantId) });
    }

    if (path === "/api/export") {
      // Download the gate-approved source as a zip — the "downloadable-tool" counterpart to a
      // live URL. Same invariant the deploy sentinel already enforces for hosted apps: no
      // artifact leaves without a passing gate run, so this checks the SAME sentinel deployGate
      // stamps (SENTINEL_REL / verifySentinel, src/gate/index.ts) — no download without one either.
      if (!auth) return json({ error: "sign in first" }, 401);
      const app = url.searchParams.get("app");
      if (!isSafeAppName(app)) return json({ error: "invalid app name" }, 400);
      if (!(await buildStore.listBuilds(auth.user.tenantId)).some((b) => b.app === app)) return json({ error: "unknown build" }, 404);
      const workspace = join(tenantDir(auth.user.tenantId), "apps", app);
      if (!verifySentinel(workspace)) return json({ error: "this build hasn't passed the security gates yet — nothing to download" }, 403);
      try {
        const zipBuf = zipWorkspace(workspace, app);
        return new Response(zipBuf, {
          headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${app}.zip"` },
        });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "export failed" }, 500);
      }
    }

    if (path === "/api/build/stop" && req.method === "POST") {
      if (!auth) return json({ error: "sign in first" }, 401);
      stopFlags.add(auth.user.tenantId);
      running.get(auth.user.tenantId)?.kill(); // LOCAL path: the running build sees the flag → finishes as "paused"
      // E2B path (build-substrate W5a): no local process to kill — set the durable flag instead,
      // read back by the sandbox's own checkpoint-ping on its next round. Harmless no-op for a
      // local build (nothing ever reads this field on that path). A no-op if there's no active
      // build for this tenant (patchActive's own contract).
      await buildStore.patchActive(auth.user.tenantId, { stopRequested: true });
      return json({ ok: true });
    }

    if (path === "/api/build") {
      // GET so the browser can stream it with EventSource (cookie auth is sent same-origin).
      if (!auth) return json({ error: "sign in first" }, 401);
      // audit2 C-6: this GET has side effects (spawns a build) — reject a cross-origin caller (CSRF).
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403);
      // A dropped EventSource AUTO-RECONNECTS to this same GET. Without this guard the reconnect
      // minted a fresh app id, burned quota, and raced the in-flight build to a bogus "blocked"
      // with zero findings (found live 2026-07-04, fresh-eyes walkthrough). One build per tenant.
      if (await isBuildRunning(auth.user.tenantId)) return json({ error: "a build is already running — reload the page to reattach, or Stop it first" }, 409);
      // EPIC #32 follow-up: whole-platform cap, independent of the per-tenant guard above.
      if (await atBuildCapacity()) return json({ error: "the platform is at capacity right now — please try again in a few minutes" }, 503);
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
      return await buildStream(auth.user.tenantId, prompt, app, "build", design);
    }

    if (path === "/api/redeploy" || path === "/api/polish") {
      // redeploy: re-ship with the tenant's now-saved keys (#5). polish: art-director pass + re-ship (#12).
      if (!auth) return json({ error: "sign in first" }, 401);
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403); // audit2 C-6 CSRF
      if (await isBuildRunning(auth.user.tenantId)) return json({ error: "a build is already running — reload the page to reattach, or Stop it first" }, 409); // same reconnect guard as /api/build
      if (await atBuildCapacity()) return json({ error: "the platform is at capacity right now — please try again in a few minutes" }, 503);
      const app = url.searchParams.get("app")?.trim();
      const rec = app ? (await buildStore.listBuilds(auth.user.tenantId)).find((b) => b.app === app) : null;
      if (!rec) return json({ error: "no such build" }, 404);
      const denied = await guardBuild(auth.user.tenantId, app!);
      if (denied) return json({ error: denied }, 403);
      return await buildStream(auth.user.tenantId, rec.prompt, app, path === "/api/polish" ? "polish" : "ship");
    }

    if (path === "/api/change" || path === "/api/rollback") {
      // EPIC #52: change = structured delta → scoped regeneration → FULL gate line → re-ship.
      // rollback = restore the pre-change snapshot → re-ship (the ship re-gates the restored tree).
      if (!auth) return json({ error: "sign in first" }, 401);
      if (!sameOrigin(req)) return json({ error: "cross-origin request refused" }, 403); // audit3 D-2 CSRF
      if (await isBuildRunning(auth.user.tenantId)) return json({ error: "a build is already running — reload the page to reattach, or Stop it first" }, 409);
      if (await atBuildCapacity()) return json({ error: "the platform is at capacity right now — please try again in a few minutes" }, 503);
      const app = url.searchParams.get("app")?.trim();
      if (app && !isSafeAppName(app)) return json({ error: "invalid app id" }, 400); // C1 traversal guard
      const rec = app ? (await buildStore.listBuilds(auth.user.tenantId)).find((b) => b.app === app) : null;
      if (!rec) return json({ error: "no such build" }, 404);
      const denied = await guardBuild(auth.user.tenantId, app!);
      if (denied) return json({ error: denied }, 403);
      if (path === "/api/rollback") return await buildStream(auth.user.tenantId, rec.prompt, app, "rollback");
      const request = url.searchParams.get("request")?.trim();
      if (!request) return json({ error: "describe the change" }, 400);
      return await buildStream(auth.user.tenantId, request, app, "change");
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

async function buildStream(tenantId: string, prompt: string, resumeApp?: string, mode: "build" | "ship" | "polish" | "change" | "rollback" = "build", design?: string): Promise<Response> {
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
  // Per-tenant steering (EPIC #54): drop the tenant's rules into the workspace for the CLI
  // subprocess (codegen + fixer read them via readWorkspaceSteering). Stored pre-normalized;
  // written every build so an edit between builds takes effect on the next one.
  const steeringRules = await tenantKv.get(tenantId, "steering");
  mkdirSync(join(workspace, ".vibehard"), { recursive: true });
  writeFileSync(join(workspace, STEERING_FILE), steeringRules ?? "");
  stopFlags.delete(tenantId);
  const byo = await loadKey(tenantId);
  // The tenant's key (if set) overrides the operator's for THIS build's child process. The
  // override must be TOTAL: providerOf() in the child resolves openrouter → opencode → anthropic
  // by env presence, so the operator's gateway keys must be REMOVED or they'd out-prioritize the
  // tenant's key and their builds would silently bill the platform.
  const env: Record<string, string> = { ...process.env, VIBEHARD_MANAGED: "1" };
  if (byo) {
    delete env.OPENROUTER_API_KEY;
    delete env.OPENCODE_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    if (byo.startsWith("sk-ant-")) env.ANTHROPIC_API_KEY = byo;
    else if (byo.startsWith("sk-or-")) env.OPENROUTER_API_KEY = byo;
    else env.OPENCODE_API_KEY = byo; // other OpenAI-compatible / gateway key
  }
  const integrations = await loadIntegrations(tenantId);
  Object.assign(env, integrations); // the tenant's third-party keys → deploy injects the app's subset (#5)
  // C-6 (audit3): the build subprocess env merges operator + tenant values; tell deploy-time
  // collectAppEnv which keys are the TENANT's own (their keychain) so an operator value under a
  // colliding name (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) is never injected into the tenant app.
  const integrationKeyNames = await integrationKeys(tenantId);
  env.VIBEHARD_TENANT_KEYS = integrationKeyNames.join(",");
  if (design) env.VIBEHARD_DESIGN = design; // #12: the chosen design preset → codegen styling
  // build-substrate W4/W5b (SPEC decision #8): the E2B path's explicit, minimal allowlist —
  // NEVER the `env` above, which still spreads `...process.env` for the local-spawn path
  // (unchanged). Real bug found live 2026-07-11: the first wiring of this dispatcher passed
  // `env` to BOTH paths, meaning DATABASE_URL/VIBEHARD_SECRETS_KEY/every operator secret would
  // have leaked into every E2B sandbox. flyApiToken/vibehardSecretsKey ARE deliberately included
  // (ship needs them — see build-env.ts's own doc comment for the tradeoff this accepts).
  // THE BUG THIS CLOSES (found live 2026-07-11 via a real production dispatch): a tenant with no
  // BYO key — the common, default, turnkey case — rides the OPERATOR's own platform key on the
  // LOCAL path today via `env`'s blind `{...process.env}` inheritance above. assembleBuildEnv()
  // has no such implicit fallback, so `byoKey: byo` alone (byo === null for most tenants) meant
  // NO LLM key at all reached the sandbox, for the overwhelming majority of builds.
  const e2bEnvParts: BuildEnvParts = {
    byoKey: byo ?? operatorLLMKey(process.env) ?? null,
    integrations,
    integrationKeyNames,
    design,
    flyApiToken: process.env.FLY_API_TOKEN,
    vibehardSecretsKey: process.env.VIBEHARD_SECRETS_KEY,
    flyOrg: process.env.FLY_ORG,
    flyRegion: process.env.FLY_REGION,
    supabaseManagementToken: process.env.SUPABASE_ACCESS_TOKEN ?? process.env.SUPABASE_PAT,
  };
  // Pre-flight balance check (found live 2026-07-09: a build died mid-plan when the platform's
  // OpenRouter account ran to $0) — BEFORE any durable "running" state is written below, so a
  // refusal here never leaves the tenant looking like they have a stuck build.
  const budget = await checkOpenRouterBudget(env);
  if (!budget.ok) return json({ error: budget.reason }, 503);
  await buildStore.setActive(tenantId, { app, prompt, status: "running" });
  // Record in the persistent history (or flip an existing record back to running on resume).
  if (resumeApp && (await buildStore.listBuilds(tenantId)).some((b) => b.app === app)) await buildStore.patchBuild(tenantId, app, { status: "running" });
  else await buildStore.appendBuild(tenantId, { app, prompt, status: "running", at: Date.now() });
  let heldTicket: string | undefined; // captured from the build's ::held marker
  let liveUrl: string | undefined; // captured from ship's "LIVE → <url>" line
  const enc = new TextEncoder();
  const finish = async (status: ActiveBuild["status"]) => {
    await buildStore.setActive(tenantId, { app, prompt, status });
    await buildStore.patchBuild(tenantId, app, { status, ...(heldTicket ? { ticket: heldTicket } : {}), ...(liveUrl ? { url: liveUrl } : {}) });
    if (status === "blocked") void notifyOperatorHeld({ tenantId, app, prompt, ticket: heldTicket });
    // THE BUG THIS CLOSES (found 2026-07-12 verifying wiring before a real build test, not by a
    // failure): Orchestrator.onEvent exists specifically to push PROACTIVE messages into the
    // tenant's own chat inbox ("🛑 Held for review…", "🚀 Shipped.") — fully built, fully tested
    // (proactiveMessage()'s own unit tests) — but buildStream() never called it. The orchestrator
    // only ever reacted to messages the tenant explicitly sent; it never actually saw a build
    // happen. notifyOperatorHeld above is a SEPARATE, operator-facing email — it was never a
    // substitute for this. Best-effort: a notification failure must never fail the build itself.
    try {
      const orchestrator = await getOrchestrator(tenantId, app);
      if (status === "blocked" && heldTicket) {
        await orchestrator.onEvent({ type: "held", ticket: heldTicket, reason: "Gate checks found something that needs a decision." });
      } else if (status === "live") {
        await orchestrator.onEvent({ type: "shipped" });
      } else if (status === "deploy-failed") {
        await orchestrator.onEvent({ type: "done", ok: false, summary: "Gates passed, but the deploy itself failed." });
      } else if (status === "error") {
        await orchestrator.onEvent({ type: "done", ok: false, summary: "An unexpected error stopped the build." });
      }
      // "paused" is the tenant's OWN action (they clicked Stop) — no need to tell them what
      // they just did; "running" is set once at start, never reached via finish() itself.
    } catch {
      /* best-effort — the build's own outcome is already durable via buildStore above */
    }
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
      // Heartbeat: codegen goes minutes without a log line, and an idle SSE connection gets cut by
      // the edge proxy — both observed stream drops (2026-07-04) happened exactly there. An SSE
      // comment line every 20s keeps the connection warm; browsers ignore it.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: hb\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 20_000);
      // build-substrate W4: runStep now goes through the ONE runPipeline seam instead of
      // spawning `bun src/cli.ts ...` inline — local subprocess by default (byte-for-byte the
      // same spawn+line-tee this replaced), or an E2B BuildWorker sandbox when
      // VIBEHARD_BUILD_WORKER=e2b. Marker-scanning (::held/LIVE →) and the SSE `send("log", …)`
      // relay are UNCHANGED, just moved into the onLog callback runPipeline calls per line.
      let lastStopped = false; // true only when the E2B path's cooperative stop was honored (W5a)
      const runStep = async (label: string, mode: BuildMode, args: string[] = []): Promise<number> => {
        send("step", label);
        const result = await runPipeline({
          tenantId,
          app,
          mode,
          args,
          workspace,
          env,
          e2bEnvParts,
          onLog: (ln) => {
            const h = ln.match(/::held (\S+)/);
            if (h) {
              heldTicket = h[1]; // internal marker → capture, don't show
              return;
            }
            const u = ln.match(/LIVE → (\S+)/);
            if (u) liveUrl = u[1];
            send("log", ln);
          },
          registerKill: (kill) => running.set(tenantId, { kill }),
          unregisterKill: () => running.delete(tenantId),
        });
        lastStopped = result.stopped;
        return result.exitCode;
      };
      // stopFlags is the LOCAL-path signal (this same machine handled /api/build/stop AND is
      // streaming this build) — lastStopped is the E2B-path signal (authoritative regardless of
      // which machine handled /api/build/stop, since it's read back off the durable flag via the
      // sandbox's own checkpoint-ping, W5a). Either one means "yes, a stop was honored."
      const stopped = () => stopFlags.has(tenantId) || lastStopped;
      try {
        if (mode === "build") {
          const buildCode = await runStep("Building + gating your app…", "build", [prompt]);
          if (stopped()) {
            stopFlags.delete(tenantId);
            await finish("paused");
            return send("done", "paused");
          }
          if (buildCode !== 0) {
            await finish("blocked"); // gate held or the build couldn't pass
            return send("done", "blocked");
          }
        } else if (mode === "polish") {
          await runStep("Polishing the design…", "polish"); // reverts itself if it would break; then we re-ship
        } else if (mode === "change") {
          // EPIC #52: `prompt` here is the CHANGE REQUEST. The CLI runs delta → scoped regen →
          // the full gate line + auto-fix; a nonzero exit means blocked/held, same as build.
          const changeCode = await runStep("Applying your change + re-checking everything…", "change", [prompt]);
          if (stopped()) {
            stopFlags.delete(tenantId);
            await finish("paused");
            return send("done", "paused");
          }
          if (changeCode !== 0) {
            await finish("blocked");
            return send("done", "blocked");
          }
        } else if (mode === "rollback") {
          const rbCode = await runStep("Restoring the previous version…", "rollback");
          if (rbCode !== 0) {
            await finish("error");
            return send("done", "error");
          }
        }
        const shipLabel =
          mode === "build" ? "Provisioning your database + deploying…"
          : mode === "polish" ? "Deploying the polished design…"
          : mode === "change" ? "Deploying the updated app…"
          : mode === "rollback" ? "Re-deploying the restored version…"
          : "Re-deploying with your saved keys…";
        const shipCode = await runStep(shipLabel, "ship");
        if (stopped()) {
          stopFlags.delete(tenantId);
          await finish("paused");
          return send("done", "paused");
        }
        const status = shipCode === 0 ? "live" : "deploy-failed";
        await finish(status);
        send("done", status);
      } catch (e) {
        await finish("error");
        send("log", `error: ${e instanceof Error ? e.message : String(e)}`);
        send("done", "error");
      } finally {
        running.delete(tenantId);
        clearInterval(heartbeat);
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

await sweepStaleRunning(); // resolve any builds left "running" by a previous server stop
setInterval(() => void sweepOrphanedWorkers(), 5 * 60_000); // build-substrate W6, periodic (not just at boot)
// One-time import of a surviving legacy users.json into the durable store (Pg rows always win).
const importedUsers = await migrateLegacyUsersFile(userStore, USERS);
if (importedUsers) console.log(`  imported ${importedUsers} account(s) from legacy users.json into platform_users`);
// Same for the per-tenant files (llm-key.enc, integrations.json, orchestrator inboxes).
const importedKv = await migrateLegacyTenantFiles(tenantKv, ROOT);
if (importedKv) console.log(`  imported ${importedKv} legacy tenant file entr${importedKv === 1 ? "y" : "ies"} into tenant_kv`);
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
