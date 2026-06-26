/**
 * GitHub APP authentication (replaces the single-user PAT — roadmap Phase 4, live half). A GitHub App
 * acts on each user's repo through a short-lived INSTALLATION token, so one app serves many users with
 * fine-grained, per-install scope and no shared secret. Two steps:
 *   1. sign a short-lived RS256 JWT with the app's private key (proves "I am app <id>")   — pure crypto
 *   2. exchange it for an installation access token scoped to one install                 — one API call
 *
 * Step 1 is offline-testable (sign + verify with a generated keypair). Step 2 sits behind a fetch seam
 * so the token cache + refresh logic test with a fake. Secrets come from the host env, never an arg in
 * source or a value echoed to a log.
 */
import { createSign } from "node:crypto";

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A short-lived (≤10 min) RS256 JWT identifying the app. `nowSec` is injected for deterministic
 *  tests; the wrapper below stamps it from the clock. iat is backdated 60s for clock skew (GitHub's
 *  documented guidance), exp capped at 9 min to stay under their 10-min hard limit. */
export function appJwt(appId: string, privateKeyPem: string, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string> }): Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;
}

export interface InstallationToken {
  token: string;
  /** ISO timestamp; GitHub installation tokens live ~1 hour. */
  expiresAt: string;
}

export interface AppCredentials {
  appId: string;
  privateKeyPem: string;
}

export interface TokenExchangeOptions {
  fetchImpl?: FetchLike;
  apiBase?: string;
  /** injected clock (seconds) for deterministic tests. */
  nowSec?: number;
}

/** Mint an installation access token for one install: JWT → POST /app/installations/{id}/access_tokens.
 *  The returned token is the Bearer for that install's git pushes + API calls, scoped to its repos. */
export async function installationToken(creds: AppCredentials, installationId: number, opts: TokenExchangeOptions = {}): Promise<InstallationToken> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const jwt = appJwt(creds.appId, creds.privateKeyPem, nowSec);
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const res = await fetchImpl(`${opts.apiBase ?? "https://api.github.com"}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`installation token for ${installationId} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token || !body.expires_at) throw new Error(`installation token response missing token/expires_at`);
  return { token: body.token, expiresAt: body.expires_at };
}

/** A caching token getter: reuse the installation token until ~2 min before it expires, then refresh.
 *  One per (app, installation). Avoids minting a token on every push/pull. */
export function installationTokenProvider(creds: AppCredentials, installationId: number, opts: TokenExchangeOptions = {}): () => Promise<string> {
  let cached: InstallationToken | null = null;
  const stillFresh = (t: InstallationToken, nowMs: number) => Date.parse(t.expiresAt) - nowMs > 120_000;
  return async () => {
    const nowMs = (opts.nowSec ?? Date.now() / 1000) * 1000;
    if (cached && stillFresh(cached, nowMs)) return cached.token;
    cached = await installationToken(creds, installationId, opts);
    return cached.token;
  };
}

/** Build credentials from the host env (never from a function arg in product code). The private key
 *  is read from a file path (GITHUB_APP_PRIVATE_KEY_PATH) or an inline PEM (GITHUB_APP_PRIVATE_KEY),
 *  so it's never pasted into a command or a chat. Returns null when not configured (PAT fallback). */
export function appCredentialsFromEnv(readFile: (p: string) => string): AppCredentials | null {
  const appId = process.env.GITHUB_APP_ID;
  if (!appId) return null;
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const inline = process.env.GITHUB_APP_PRIVATE_KEY;
  const privateKeyPem = path ? readFile(path) : inline;
  if (!privateKeyPem) return null;
  return { appId, privateKeyPem };
}
