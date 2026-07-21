import { describe, expect, test } from "bun:test";
import { httpFleetStore } from "./http-client.ts";
import type { Candidate, Convention } from "./store.ts";

const conventions: Convention[] = [{ id: "no-clerk", stack: "next-supabase", phase: "both", builds: 6, addresses: "rls:x", rule: "Use Supabase Auth." }];
const cand: Candidate = { key: "next-supabase::verify:x", stack: "next-supabase", signal: "verify:x", builds: 2, apps: ["a"], resolutions: [] };

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

describe("httpFleetStore — a sandboxed build's ONLY path to the platform-wide fleet tables (2026-07-20)", () => {
  test("getConventions(): bearer-authed GET, no app in the query string (fleet data is global)", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, json: { conventions } }));
    const store = httpFleetStore({ baseUrl: "https://vibehard.example", token: "tok-abc", fetchImpl });
    expect(await store.getConventions()).toEqual(conventions);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://vibehard.example/api/internal/fleet-conventions");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-abc");
  });
  test("getConventions(): non-ok status throws", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 500 }));
    const store = httpFleetStore({ baseUrl: "https://x", token: "t", fetchImpl });
    await expect(store.getConventions()).rejects.toThrow(/GET failed: 500/);
  });

  test("getCandidate(): bearer-authed GET with the key in the query string; 200 → the candidate", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, json: { candidate: cand } }));
    const store = httpFleetStore({ baseUrl: "https://vibehard.example", token: "tok-abc", fetchImpl });
    expect(await store.getCandidate("next-supabase::verify:x")).toEqual(cand);
    expect(calls[0]!.url).toBe("https://vibehard.example/api/internal/fleet-candidates?key=next-supabase%3A%3Averify%3Ax");
  });
  test("getCandidate(): 404 → null (no candidate yet), never thrown", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404 }));
    const store = httpFleetStore({ baseUrl: "https://x", token: "t", fetchImpl });
    expect(await store.getCandidate("k")).toBeNull();
  });

  test("putCandidate(): bearer-authed PUT with the candidate as JSON body, key in the query string", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200 }));
    const store = httpFleetStore({ baseUrl: "https://vibehard.example", token: "tok-abc", fetchImpl });
    await store.putCandidate(cand);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toContain("key=next-supabase");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ candidate: cand });
  });
  test("putCandidate(): non-ok response throws", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 403 }));
    const store = httpFleetStore({ baseUrl: "https://x", token: "wrong", fetchImpl });
    await expect(store.putCandidate(cand)).rejects.toThrow(/PUT failed: 403/);
  });

  test("putConvention()/listCandidates() are operator-only — throw rather than silently no-op", async () => {
    const store = httpFleetStore({ baseUrl: "https://x", token: "t" });
    await expect(store.putConvention(conventions[0]!)).rejects.toThrow(/operator action/);
    await expect(store.listCandidates()).rejects.toThrow(/operator action/);
  });
});
