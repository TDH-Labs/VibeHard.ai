import { describe, expect, test } from "bun:test";
import type { EscalationTicket } from "./queue.ts";
import { formatOpenedMessage, nullNotifier, slackNotifier, type FetchLike } from "./notify.ts";

function ticket(): EscalationTicket {
  return {
    id: "esc-abc123",
    state: "needs-human",
    packet: { workspacePath: "/app", createdAt: "t", reason: "blocked", items: [], specialties: ["security", "database"], blocking: 2 },
    claimedBy: null,
    decisions: [],
    createdAt: "t",
    updatedAt: "t",
  };
}

describe("formatOpenedMessage", () => {
  test("includes the blocking count, specialties, ticket id and a claim hint", () => {
    const msg = formatOpenedMessage(ticket());
    expect(msg).toContain("2 blocking");
    expect(msg).toContain("esc-abc123");
    expect(msg).toContain("security, database");
    expect(msg).toContain("drydock claim esc-abc123");
  });
});

describe("nullNotifier", () => {
  test("is a silent no-op (resolves, no throw)", async () => {
    await expect(nullNotifier.notifyOpened(ticket())).resolves.toBeUndefined();
  });
});

describe("slackNotifier", () => {
  test("POSTs the formatted message as a Slack text payload, with a timeout signal", async () => {
    const calls: { url: string; body: string; hasSignal: boolean }[] = [];
    const fakeFetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body, hasSignal: init.signal instanceof AbortSignal });
      return { ok: true };
    };
    await slackNotifier("https://hooks.slack.test/abc", fakeFetch).notifyOpened(ticket());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.slack.test/abc");
    expect(JSON.parse(calls[0]!.body).text).toContain("esc-abc123");
    expect(calls[0]!.hasSignal).toBe(true); // bounded — a hung webhook can't block the escalation
  });

  test("swallows a thrown fetch — best-effort, never breaks the escalation", async () => {
    const boom: FetchLike = async () => {
      throw new Error("network down");
    };
    await expect(slackNotifier("https://x", boom).notifyOpened(ticket())).resolves.toBeUndefined();
  });
});
