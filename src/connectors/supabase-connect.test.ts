import { describe, expect, test } from "bun:test";
import { validateSupabaseConnection, supabaseKeychainEntries, isAllowedSupabaseHost, type SupabaseConnectInput } from "./supabase-connect.ts";

// A fake fetch that answers by (path, key) so we can simulate good/bad keys without a network.
function fakeFetch(routes: Record<string, (key: string) => number>) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    const key = (init?.headers as Record<string, string>)?.apikey ?? "";
    const path = u.pathname.replace(/\/$/, "") || "/";
    const status = routes[path]?.(key) ?? 404;
    return new Response(status >= 400 ? "err" : "{}", { status });
  };
}

const ANON = "anon-key-123";
const SERVICE = "service-key-456";
const good: SupabaseConnectInput = { url: "https://abcd.supabase.co", anonKey: ANON, serviceKey: SERVICE };

// /auth/v1/settings accepts either real key; the admin endpoint accepts ONLY the service key.
const liveProject = fakeFetch({
  "/auth/v1/settings": (k) => (k === ANON || k === SERVICE ? 200 : 401),
  "/auth/v1/admin/users": (k) => (k === SERVICE ? 200 : 401),
});

describe("validateSupabaseConnection — proves keys against the live project", () => {
  test("all three checks pass for a correct URL + anon + service", async () => {
    const r = await validateSupabaseConnection(good, liveProject);
    expect(r.ok).toBe(true);
    expect(r.ref).toBe("abcd");
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  test("a malformed URL fails fast, before any key is sent", async () => {
    let called = false;
    const r = await validateSupabaseConnection({ ...good, url: "not a url" }, async () => {
      called = true;
      return new Response("{}");
    });
    expect(r.ok).toBe(false);
    expect(r.checks[0]!.name).toBe("url");
    expect(called).toBe(false);
  });

  test("http (non-https) URL is rejected — keys must never travel in the clear", async () => {
    const r = await validateSupabaseConnection({ ...good, url: "http://abcd.supabase.co" }, liveProject);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "url")?.ok).toBe(false);
  });

  test("a wrong anon key is caught (PostgREST 401)", async () => {
    const r = await validateSupabaseConnection({ ...good, anonKey: "wrong" }, liveProject);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "anon-key")?.ok).toBe(false);
  });

  test("anon-key-in-both-boxes is caught — authenticates to REST but fails the admin probe", async () => {
    const r = await validateSupabaseConnection({ ...good, serviceKey: ANON }, liveProject);
    expect(r.ok).toBe(false);
    const svc = r.checks.find((c) => c.name === "service-key");
    expect(svc?.ok).toBe(false);
    expect(svc?.detail).toContain("service_role");
  });

  test("missing keys fail without a network call", async () => {
    const r = await validateSupabaseConnection({ ...good, serviceKey: "  " }, liveProject);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "keys-present")?.ok).toBe(false);
  });

  test("a trailing slash / missing scheme on the URL is normalized", async () => {
    const r = await validateSupabaseConnection({ ...good, url: "abcd.supabase.co/" }, liveProject);
    expect(r.ok).toBe(true);
    expect(r.ref).toBe("abcd");
  });
});

describe("SSRF guard (audit2 C-3) — only public Supabase hosts are fetched", () => {
  test("isAllowedSupabaseHost accepts Supabase hosts, rejects everything else + IP literals", () => {
    for (const ok of ["abcd.supabase.co", "x-y-z.supabase.co", "proj.supabase.in"]) {
      expect(isAllowedSupabaseHost(ok)).toBe(true);
    }
    for (const bad of [
      "metadata.google.internal",
      "169.254.169.254",
      "127.0.0.1",
      "10.0.0.5",
      "localhost",
      "evil.com",
      "abcd.supabase.co.evil.com",
      "[::1]",
    ]) {
      expect(isAllowedSupabaseHost(bad)).toBe(false);
    }
  });

  test("an internal-metadata URL is rejected before ANY fetch", async () => {
    let called = false;
    const r = await validateSupabaseConnection({ ...good, url: "https://metadata.google.internal" }, async () => {
      called = true;
      return new Response("{}");
    });
    expect(r.ok).toBe(false);
    expect(r.checks[0]!.name).toBe("url");
    expect(called).toBe(false); // SSRF guard fired before the network call
  });

  test("an IP-literal URL is rejected before ANY fetch", async () => {
    let called = false;
    const r = await validateSupabaseConnection({ ...good, url: "https://169.254.169.254" }, async () => {
      called = true;
      return new Response("{}");
    });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("an operator-allowlisted suffix can be added via env (self-hosted escape hatch)", () => {
    const prev = process.env.VIBEHARD_SUPABASE_HOST_SUFFIXES;
    process.env.VIBEHARD_SUPABASE_HOST_SUFFIXES = ".db.mycorp.com";
    try {
      expect(isAllowedSupabaseHost("supabase.db.mycorp.com")).toBe(true);
      expect(isAllowedSupabaseHost("evil.com")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.VIBEHARD_SUPABASE_HOST_SUFFIXES;
      else process.env.VIBEHARD_SUPABASE_HOST_SUFFIXES = prev;
    }
  });
});

describe("supabaseKeychainEntries — the encrypted values a successful connect persists", () => {
  test("maps to the three canonical env names with a normalized URL", () => {
    const e = supabaseKeychainEntries({ url: "abcd.supabase.co/", anonKey: ` ${ANON} `, serviceKey: SERVICE });
    expect(e).toEqual({
      SUPABASE_URL: "https://abcd.supabase.co",
      SUPABASE_ANON_KEY: ANON,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    });
  });
});
