import { describe, expect, test } from "bun:test";
import { httpEscalationSink } from "./http-client.ts";
import { ticketId, type EscalationTicket } from "./queue.ts";
import type { EscalationPacket } from "./packet.ts";

const packet: EscalationPacket = {
  workspacePath: "/home/user/workspace",
  createdAt: "2026-07-20T00:00:00.000Z",
  reason: "deploy blocked by the gate chain",
  items: [{ ref: "app/update-password/page.tsx:1:sast-1", finding: { tool: "sast", file: "app/update-password/page.tsx", line: 1, ruleId: "sast-1", severity: "high", message: "x" }, specialty: "security", slice: null }],
  specialties: ["security"],
  blocking: 1,
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

describe("httpEscalationSink — a build sandbox's ONLY durable read/write of its own held ticket (2026-07-20)", () => {
  test("open(): no existing ticket → GET (miss) then PUT the newly-opened ticket, bearer-authed, app+id in the query string", async () => {
    const { fetchImpl, calls } = fakeFetch((c) => (c.method === "GET" ? { status: 404 } : { status: 200 }));
    const sink = httpEscalationSink({ baseUrl: "https://vibehard.example", token: "tok-abc", app: "accept-c6", fetchImpl });
    const ticket = await sink.open(packet, "2026-07-20T00:00:00.000Z");
    expect(ticket.id).toBe(ticketId(packet));
    expect(ticket.state).toBe("needs-human");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`https://vibehard.example/api/internal/escalation-ticket?app=accept-c6&id=${ticket.id}`);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-abc");
    expect(calls[1]!.method).toBe("PUT");
    expect(JSON.parse(calls[1]!.body!)).toEqual({ ticket });
  });

  test("open(): an existing ticket (GET hit) → returned as-is, no PUT (idempotent re-queue, matching LocalEscalationSink)", async () => {
    const id = ticketId(packet);
    const existing: EscalationTicket = { id, state: "claimed", packet, claimedBy: "alice", decisions: [], createdAt: "t0", updatedAt: "t1" };
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, json: { ticket: existing } }));
    const sink = httpEscalationSink({ baseUrl: "https://x", token: "t", app: "accept-c6", fetchImpl });
    expect(await sink.open(packet)).toEqual(existing);
    expect(calls).toHaveLength(1); // GET only — no PUT once a ticket already exists
  });

  test("open(): PUT failing (non-ok) throws — a lost held ticket must be loud, never silently swallowed", async () => {
    const { fetchImpl } = fakeFetch((c) => (c.method === "GET" ? { status: 404 } : { status: 500 }));
    const sink = httpEscalationSink({ baseUrl: "https://x", token: "t", app: "accept-c6", fetchImpl });
    await expect(sink.open(packet)).rejects.toThrow(/PUT failed: 500/);
  });

  test("get(): 404 → null (no such ticket), never thrown", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404 }));
    const sink = httpEscalationSink({ baseUrl: "https://x", token: "t", app: "accept-c6", fetchImpl });
    expect(await sink.get("esc-nope")).toBeNull();
  });

  test("get(): any other non-ok status throws", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 500 }));
    const sink = httpEscalationSink({ baseUrl: "https://x", token: "t", app: "accept-c6", fetchImpl });
    await expect(sink.get("esc-1")).rejects.toThrow(/GET failed: 500/);
  });

  test("claim()/resolve()/list() are reviewer actions — deliberately unreachable via a sandboxed dispatch token, not silently stubbed", async () => {
    const sink = httpEscalationSink({ baseUrl: "https://x", token: "t", app: "accept-c6", fetchImpl: fakeFetch(() => ({ status: 200 })).fetchImpl });
    await expect(sink.claim("esc-1", "alice")).rejects.toThrow(/reviewer action/);
    await expect(sink.resolve("esc-1", [])).rejects.toThrow(/reviewer action/);
    await expect(sink.list()).rejects.toThrow(/single-app scope/);
  });
});
