/**
 * Notification seam (backlog #3, docs/specs/reviewer-moat.md). When an escalation is QUEUED,
 * reviewers should learn about it without polling the queue. The seam is deliberately tiny and
 * BEST-EFFORT: a notifier failure (Slack down, no webhook) must never lose or block the queued
 * ticket — the queue is the source of truth, the notification is a courtesy ping.
 *
 * `nullNotifier` is the silent default (no webhook configured). `slackNotifier` posts a formatted
 * summary to an incoming webhook; `fetch` is injected so it's unit-testable offline.
 */
import type { EscalationTicket } from "./queue.ts";

export interface Notifier {
  readonly name: string;
  /** Fire-and-forget courtesy ping that a packet was queued. Must not throw. */
  notifyOpened(ticket: EscalationTicket): Promise<void>;
}

/** Pure: the human-readable summary a reviewer sees — what's blocked, what specialty it needs,
 *  and how to pick it up. No code slices (those live in `drydock review <id>`). */
export function formatOpenedMessage(ticket: EscalationTicket): string {
  const p = ticket.packet;
  const specialties = p.specialties.length ? p.specialties.join(", ") : "general";
  return [
    `🔒 drydock review needed — ${p.blocking} blocking finding(s)`,
    `• ticket: ${ticket.id}`,
    `• specialties: ${specialties}`,
    `• app: ${p.workspacePath}`,
    `• claim it: drydock claim ${ticket.id} <your-reviewer-id>`,
  ].join("\n");
}

/** The minimal fetch shape slackNotifier needs (injectable for tests). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean }>;

export const nullNotifier: Notifier = {
  name: "null",
  async notifyOpened() {
    /* no webhook configured — silent no-op */
  },
};

/** Post the opened-ticket summary to a Slack incoming webhook. Best-effort: any error (network,
 *  non-2xx) is swallowed so the escalation that triggered it still succeeds. */
export function slackNotifier(webhookUrl: string, fetchImpl?: FetchLike): Notifier {
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init) as Promise<{ ok: boolean }>);
  return {
    name: "slack",
    async notifyOpened(ticket: EscalationTicket): Promise<void> {
      try {
        await doFetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: formatOpenedMessage(ticket) }),
          signal: AbortSignal.timeout(5_000), // a hung webhook must not block the escalation path
        });
      } catch {
        /* best-effort: never let a notification failure break the escalation */
      }
    },
  };
}
