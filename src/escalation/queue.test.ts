import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalEscalationSink,
  claimTicket,
  openTicket,
  resolveTicket,
  ticketId,
  type EscalationTicket,
} from "./queue.ts";
import type { EscalationPacket } from "./packet.ts";
import type { ReviewDecision } from "./review.ts";

const ts = "2026-06-21T00:00:00.000Z";

function packet(over: Partial<EscalationPacket> = {}): EscalationPacket {
  return {
    workspacePath: "/tmp/app",
    createdAt: ts,
    reason: "deploy blocked by the gate chain",
    blocking: 1,
    specialties: ["security"],
    items: [
      {
        ref: "src/db.js:10:rules.sqlite-template-literal-query",
        finding: { tool: "semgrep", ruleId: "rules.sqlite-template-literal-query", severity: "high", file: "/src/db.js", line: 10, message: "SQLi" },
        specialty: "security",
        slice: null,
      },
    ],
    ...over,
  };
}

const decision = (over: Partial<ReviewDecision> = {}): ReviewDecision => ({
  ref: "src/db.js:10:rules.sqlite-template-literal-query",
  verdict: "fixed",
  reviewer: "alice",
  decidedAt: ts,
  ...over,
});

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function queueDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "vibehard-queue-"));
  tmps.push(d);
  return join(d, "queue");
}

describe("ticketId (pure, deterministic)", () => {
  test("same packet → same id; different workspace → different id", () => {
    expect(ticketId(packet())).toBe(ticketId(packet()));
    expect(ticketId(packet())).not.toBe(ticketId(packet({ workspacePath: "/tmp/other" })));
    expect(ticketId(packet())).toMatch(/^esc-/);
  });
});

describe("state transitions (pure, guarded)", () => {
  test("openTicket → a held needs-human ticket", () => {
    const t = openTicket(packet(), ts);
    expect(t).toMatchObject({ state: "needs-human", claimedBy: null, decisions: [] });
    expect(t.id).toBe(ticketId(packet()));
  });

  test("claim: needs-human → claimed; requires a reviewer", () => {
    const held = openTicket(packet(), ts);
    const claimed = claimTicket(held, "alice", ts);
    expect(claimed).toMatchObject({ state: "claimed", claimedBy: "alice" });
    expect(() => claimTicket(held, "  ", ts)).toThrow(/reviewer is required/);
  });

  test("claim is rejected on an already-claimed ticket (FCFS — one winner)", () => {
    const claimed = claimTicket(openTicket(packet(), ts), "alice", ts);
    expect(() => claimTicket(claimed, "bob", ts)).toThrow(/expected needs-human/);
  });

  test("resolve: claimed → resolved with decisions; needs claim first; needs a decision", () => {
    const claimed = claimTicket(openTicket(packet(), ts), "alice", ts);
    const resolved = resolveTicket(claimed, [decision()], ts);
    expect(resolved).toMatchObject({ state: "resolved" });
    expect(resolved.decisions).toHaveLength(1);
    expect(() => resolveTicket(openTicket(packet(), ts), [decision()], ts)).toThrow(/expected claimed/);
    expect(() => resolveTicket(claimed, [], ts)).toThrow(/at least one decision/);
  });
});

describe("LocalEscalationSink (file-backed async queue)", () => {
  test("open → held; get + list by state reflect the lifecycle", async () => {
    const sink = new LocalEscalationSink(await queueDir());
    const t = await sink.open(packet(), ts);
    expect(t.state).toBe("needs-human");
    expect(await sink.get(t.id)).toMatchObject({ id: t.id, state: "needs-human" });
    expect(await sink.list("needs-human")).toHaveLength(1);
    expect(await sink.list("claimed")).toHaveLength(0);
  });

  test("open is idempotent — re-queuing the same escalation does not duplicate", async () => {
    const sink = new LocalEscalationSink(await queueDir());
    const a = await sink.open(packet(), ts);
    const b = await sink.open(packet(), "2026-06-22T00:00:00.000Z"); // later, same content
    expect(b.id).toBe(a.id);
    expect(b.createdAt).toBe(ts); // kept the original — not re-opened
    expect(await sink.list()).toHaveLength(1);
  });

  test("full async lifecycle: open → claim → resolve, persisted across calls", async () => {
    const sink = new LocalEscalationSink(await queueDir());
    const { id } = await sink.open(packet(), ts);
    await sink.claim(id, "alice", ts);
    expect((await sink.get(id))!.state).toBe("claimed");
    const resolved = await sink.resolve(id, [decision()], ts);
    expect(resolved.state).toBe("resolved");
    expect(await sink.list("resolved")).toHaveLength(1);
    expect(await sink.list("needs-human")).toHaveLength(0);
  });

  test("claim/resolve on a missing ticket throws", async () => {
    const sink = new LocalEscalationSink(await queueDir());
    expect(sink.claim("esc-nope", "alice", ts)).rejects.toThrow(/no such ticket/);
  });

  test("an empty / never-created queue lists nothing", async () => {
    const sink = new LocalEscalationSink(await queueDir());
    expect(await sink.list()).toEqual([]);
  });
});
