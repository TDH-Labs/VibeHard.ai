/**
 * "Connect Supabase" — the validated key-import wizard (the BYO-backend path, as opposed to the
 * managed auto-provision flow in src/substrate/supabase-management.ts). Supabase has NO OAuth
 * provider, so a non-technical user pastes three values from their project's API settings and we
 * PROVE the keys actually work against the live project before saving — a wrong paste fails here,
 * loudly, instead of silently at deploy time.
 *
 * What we verify (all against the project's own GoTrue/Auth endpoints, no Management API). These
 * work for BOTH key systems Supabase ships — legacy JWT (anon/service_role) and the new
 * `sb_publishable_…`/`sb_secret_…` keys (the new anon key is REJECTED by PostgREST's root, so we
 * validate against /auth instead, which accepts either format):
 *   1. the URL is a well-formed https Supabase project URL (→ a usable project ref);
 *   2. the anon key authenticates — GET /auth/v1/settings returns 200, not 401 "invalid API key";
 *   3. the service-role key authenticates AND is genuinely service-role (it can list users via the
 *      admin API — the anon key gets 401 there, so this distinguishes the two and catches the
 *      common "pasted the anon key into both boxes" mistake).
 *
 * Pure + fetch-injected so it's unit-testable offline; NEVER logs key material (§16/§21).
 */

export interface SupabaseConnectInput {
  url: string;
  anonKey: string;
  serviceKey: string;
}

export interface ConnectCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SupabaseConnectResult {
  ok: boolean;
  /** project ref (subdomain) when the URL parsed, else "" */
  ref: string;
  checks: ConnectCheck[];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Allowlisted hostnames for the connector's server-side fetch (audit2 C-3 — SSRF). We `fetch` the
 * pasted URL from the server, so an attacker who pastes `https://metadata.google.internal` or an
 * internal IP turns this into a blind-SSRF status oracle from our network vantage. A real Supabase
 * project is always `<ref>.supabase.co` (or `.supabase.in`); self-hosters can add their own suffix
 * via VIBEHARD_SUPABASE_HOST_SUFFIXES (comma-separated, e.g. ".db.mycorp.com"). Default rejects
 * everything else — and all IP literals — BEFORE any network call.
 */
const BUILTIN_SUPABASE_SUFFIXES = [".supabase.co", ".supabase.in"];
function allowedSupabaseSuffixes(): string[] {
  const extra = (process.env.VIBEHARD_SUPABASE_HOST_SUFFIXES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.startsWith("."));
  return [...BUILTIN_SUPABASE_SUFFIXES, ...extra];
}

/** True only for a public Supabase (or operator-allowlisted) hostname — never an IP literal. */
export function isAllowedSupabaseHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (!h.includes(".")) return false; // bare host (e.g. "localhost") — reject
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // IPv4 literal → no SSRF to internal ranges
  if (h.includes(":") || h.startsWith("[")) return false; // IPv6 literal
  return allowedSupabaseSuffixes().some((s) => h.endsWith(s));
}

/** Normalize a pasted URL: trim, strip a trailing slash, tolerate a missing scheme, ENFORCE the
 *  Supabase host allowlist (C-3). Returns null on anything we won't fetch. */
function normalizeUrl(raw: string): string | null {
  const t = raw.trim().replace(/\/+$/, "");
  if (!t) return null;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:") return null; // keys must never travel over http
    if (!isAllowedSupabaseHost(u.hostname)) return null; // SSRF guard — reject before any fetch
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return null;
  }
}

function refFrom(url: string): string {
  try {
    return new URL(url).hostname.split(".")[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * Validate a Supabase project URL + anon + service keys against the live project.
 * Returns ok=true only when every check passes; otherwise the failing check carries a
 * human-readable `detail` the wizard can show verbatim.
 */
export async function validateSupabaseConnection(
  input: SupabaseConnectInput,
  fetchImpl: FetchLike = fetch,
): Promise<SupabaseConnectResult> {
  const checks: ConnectCheck[] = [];

  const url = normalizeUrl(input.url);
  if (!url) {
    checks.push({ name: "url", ok: false, detail: "That isn't a valid https project URL — copy the Project URL from Supabase → Settings → API." });
    return { ok: false, ref: "", checks };
  }
  const ref = refFrom(url);
  checks.push({ name: "url", ok: true, detail: `Project ${ref}` });

  const anon = input.anonKey.trim();
  const service = input.serviceKey.trim();
  if (!anon || !service) {
    checks.push({ name: "keys-present", ok: false, detail: "Both the anon (public) key and the service_role key are required." });
    return { ok: false, ref, checks };
  }

  // 2. anon key authenticates against GoTrue. A valid key (JWT or sb_publishable_) → 200; a missing
  //    or wrong key → 401. /auth/v1/settings works on a project with zero tables, unlike PostgREST's
  //    root (which rejects the new publishable keys outright).
  const anonCheck = await probeAuthSettings(url, anon, fetchImpl);
  checks.push({
    name: "anon-key",
    ok: anonCheck.ok,
    detail: anonCheck.ok ? "Anon key authenticates." : `Anon key rejected (${anonCheck.status}). Copy the "anon public" key from Settings → API.`,
  });
  if (!anonCheck.ok) return { ok: false, ref, checks };

  // 3. service key authenticates AND is actually service-role: the Auth admin endpoint
  //    (GET /auth/v1/admin/users) requires the service key — the anon key gets 401 there.
  const svcValid = await probeAuthSettings(url, service, fetchImpl);
  if (!svcValid.ok) {
    checks.push({ name: "service-key", ok: false, detail: `Service key rejected (${svcValid.status}). Copy the "service_role" key from Settings → API.` });
    return { ok: false, ref, checks };
  }
  const adminOk = await probeAdmin(url, service, fetchImpl);
  checks.push({
    name: "service-key",
    ok: adminOk.ok,
    detail: adminOk.ok
      ? "Service key authenticates (verified against the admin API)."
      : "That key authenticates but isn't the service_role key — it can't reach the admin API. Make sure you pasted service_role, not anon, into the service box.",
  });
  if (!adminOk.ok) return { ok: false, ref, checks };

  return { ok: true, ref, checks };
}

/** GET {url}/auth/v1/settings with the key. 200 = a valid project key (anon OR service, either key
 *  format); 401 = bad/missing key. Works on a zero-table project, unlike PostgREST's root. */
async function probeAuthSettings(url: string, key: string, fetchImpl: FetchLike): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetchImpl(`${url}/auth/v1/settings`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    return { ok: res.status >= 200 && res.status < 400, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** GET {url}/auth/v1/admin/users?per_page=1 — only the service_role key is authorized here. */
async function probeAdmin(url: string, serviceKey: string, fetchImpl: FetchLike): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetchImpl(`${url}/auth/v1/admin/users?per_page=1`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    return { ok: res.status >= 200 && res.status < 400, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** The keychain entries a successful connect should persist (UPPER_SNAKE_CASE → value). */
export function supabaseKeychainEntries(input: SupabaseConnectInput): Record<string, string> {
  const url = normalizeUrl(input.url) ?? input.url.trim();
  return {
    SUPABASE_URL: url,
    SUPABASE_ANON_KEY: input.anonKey.trim(),
    SUPABASE_SERVICE_ROLE_KEY: input.serviceKey.trim(),
  };
}
