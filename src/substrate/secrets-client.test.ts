import { describe, expect, test } from "bun:test";
import { httpSecretsStore } from "./secrets-client.ts";
import type { BackendSecrets } from "./types.ts";

const secrets: BackendSecrets = {
  url: "https://iylpuqndxqwfswblwjng.supabase.co",
  anonKey: "anon-key",
  serviceKey: "service-role-key",
  dbHost: "db.iylpuqndxqwfswblwjng.supabase.co",
  dbUser: "postgres.iylpuqndxqwfswblwjng",
  dbPassword: "generated-db-password",
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(handler: (c: Call) => { status: number; json?: unknown }): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body as string | undefined,
    };
    calls.push(call);
    const { status, json } = handler(call);
    return new Response(json !== undefined ? JSON.stringify(json) : null, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("httpSecretsStore — the reused-project connection details, durable across sandboxes (2026-07-19: without this, EVERY redeploy's live-RLS probe hit an empty '' URL for the entire retry budget — no amount of waiting could fix it, since the connection was never durably reloaded)", () => {
  test("get(): bearer-authed GET with the app in the query string; 200 → the full BackendSecrets, incl. the sensitive fields (serviceKey/dbPassword) the sandbox needs to reconstruct its connection", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, json: { secrets } }));
    const store = httpSecretsStore({ baseUrl: "https://vibehard.example", token: "tok-abc", fetchImpl });
    expect(await store.get("accept-c3")).toEqual(secrets);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://vibehard.example/api/internal/backend-secrets?app=accept-c3");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-abc");
  });

  test("get(): 404 → null (no secrets yet — a genuinely first deploy, not yet provisioned)", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404 }));
    const store = httpSecretsStore({ baseUrl: "https://x", token: "t", fetchImpl });
    expect(await store.get("accept-c3")).toBeNull();
  });

  test("get(): any other non-ok status throws — never silently treated as 'no secrets' (that would mis-provision a SECOND project on a redeploy, the exact class of bug this whole fix line closes)", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 500 }));
    const store = httpSecretsStore({ baseUrl: "https://x", token: "t", fetchImpl });
    await expect(store.get("accept-c3")).rejects.toThrow(/GET failed: 500/);
  });

  test("put(): bearer-authed PUT with the secrets as JSON body, app in the query string; resolves the app id (matching SecretsStore's own contract)", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200 }));
    const store = httpSecretsStore({ baseUrl: "https://vibehard.example", token: "tok-abc", fetchImpl });
    expect(await store.put("accept-c3", secrets)).toBe("accept-c3");
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toContain("app=accept-c3");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ secrets });
  });

  test("put(): non-ok response throws", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 403 }));
    const store = httpSecretsStore({ baseUrl: "https://x", token: "wrong-scope", fetchImpl });
    await expect(store.put("accept-c3", secrets)).rejects.toThrow(/PUT failed: 403/);
  });

  test("remove(): DELETE; 404 is idempotent (already gone), not an error", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 404 }));
    const store = httpSecretsStore({ baseUrl: "https://x", token: "t", fetchImpl });
    await store.remove("accept-c3");
    expect(calls[0]!.method).toBe("DELETE");
  });

  test("remove(): a non-404 failure still throws", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 500 }));
    const store = httpSecretsStore({ baseUrl: "https://x", token: "t", fetchImpl });
    await expect(store.remove("accept-c3")).rejects.toThrow(/DELETE failed: 500/);
  });
});
