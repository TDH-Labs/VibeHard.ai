import { describe, expect, test } from "bun:test";
import { httpRecordStore } from "./record-client.ts";
import type { DeploymentRecord } from "./types.ts";

const rec: DeploymentRecord = {
  app: "myapp",
  customerOrgRef: "org-1",
  projectRef: "proj-1",
  hostRef: "host-1",
  url: "https://app.example.com",
  appliedMigrations: ["0001"],
  secretsRef: "ref-myapp",
  status: "live",
  updatedAt: "2026-07-19T00:00:00.000Z",
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

describe("httpRecordStore — the sandboxed ship's ONLY path to durable deployment state (2026-07-19)", () => {
  test("get(): bearer-authed GET with the app in the query string; 200 → the record", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, json: { record: rec } }));
    const store = httpRecordStore({ baseUrl: "https://vibehard.example", token: "tok-abc", fetchImpl });
    expect(await store.get("myapp")).toEqual(rec);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://vibehard.example/api/internal/deployment-record?app=myapp");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-abc");
  });

  test("get(): 404 → null (no record yet — a genuinely first deploy), never thrown", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404 }));
    const store = httpRecordStore({ baseUrl: "https://x", token: "t", fetchImpl });
    expect(await store.get("myapp")).toBeNull();
  });

  test("get(): any other non-ok status throws (fail loud, never silently treat an error as 'no record')", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 500 }));
    const store = httpRecordStore({ baseUrl: "https://x", token: "t", fetchImpl });
    await expect(store.get("myapp")).rejects.toThrow(/GET failed: 500/);
  });

  test("put(): bearer-authed PUT with the record as JSON body, app in the query string", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200 }));
    const store = httpRecordStore({ baseUrl: "https://vibehard.example", token: "tok-abc", fetchImpl });
    await store.put(rec);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toContain("app=myapp");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-abc");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ record: rec });
  });

  test("put(): non-ok response throws", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 403 }));
    const store = httpRecordStore({ baseUrl: "https://x", token: "wrong-scope", fetchImpl });
    await expect(store.put(rec)).rejects.toThrow(/PUT failed: 403/);
  });

  test("remove(): DELETE; 404 is treated as already-removed (idempotent), not an error", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 404 }));
    const store = httpRecordStore({ baseUrl: "https://x", token: "t", fetchImpl });
    await store.remove("myapp");
    expect(calls[0]!.method).toBe("DELETE");
  });

  test("remove(): a non-404 failure still throws", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 500 }));
    const store = httpRecordStore({ baseUrl: "https://x", token: "t", fetchImpl });
    await expect(store.remove("myapp")).rejects.toThrow(/DELETE failed: 500/);
  });
});
