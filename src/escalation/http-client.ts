/**
 * httpEscalationSink — an EscalationSink that reaches the platform's durable, Postgres-backed
 * escalation queue over a narrow, tokened HTTP endpoint. Direct sibling of
 * substrate/record-client.ts and substrate/secrets-client.ts; read those files' headers first —
 * same architecture, same reasoning, a third instance of the identical defect.
 *
 * THE BUG THIS CLOSES (found live 2026-07-20, acceptance test prompt C, second retry after the
 * CDATA-marker fix): `runAutoFixAndReport` (cli.ts) opens a ticket via `localSink().open(...)`
 * from WHEREVER the gate/fix loop is actually running — in production that's an ephemeral E2B
 * sandbox with no live DB connection and no local state that survives teardown, exactly like the
 * deployment-record and backend-secrets bugs before it. The ticket file lands on the sandbox's own
 * disk and is destroyed the instant the build holds. `/api/held` then asks the PLATFORM's own
 * queue for that same ticket id and finds nothing — every E2B-dispatched held build has therefore
 * been silently unexplainable ("held by the gates", zero findings shown), defeating the exact
 * transparency the product promises ("every gate, shown").
 *
 * Scope, deliberately narrower than LocalEscalationSink's full EscalationSink: a build sandbox's
 * dispatch token is authorized for exactly one (tenantId, app) — the same scoping
 * authorizeRecordRequest already enforces for record/secrets. `open()` and `get()` fit that scope
 * (a build only ever opens/reads its OWN ticket). `claim()`/`resolve()`/`list()` are reviewer
 * actions that need to enumerate or act across tickets outside any single build's scope — they are
 * not, and should never be, reachable from inside a build sandbox, so they throw rather than being
 * silently stubbed to a no-op.
 */
import { openTicket, ticketId, type EscalationSink, type EscalationTicket } from "./queue.ts";
import type { EscalationPacket } from "./packet.ts";

const PATH = "/api/internal/escalation-ticket";

export interface HttpEscalationSinkOptions {
  baseUrl: string;
  token: string;
  app: string;
  fetchImpl?: typeof fetch;
}

export function httpEscalationSink(opts: HttpEscalationSinkOptions): EscalationSink {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = (id: string) => `${opts.baseUrl}${PATH}?app=${encodeURIComponent(opts.app)}&id=${encodeURIComponent(id)}`;
  const auth = { Authorization: `Bearer ${opts.token}` };

  const get = async (id: string): Promise<EscalationTicket | null> => {
    const res = await doFetch(url(id), { headers: auth });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`escalation-ticket GET failed: ${res.status}`);
    const body = (await res.json()) as { ticket: EscalationTicket | null };
    return body.ticket ?? null;
  };

  return {
    name: "http-escalation",
    async open(packet: EscalationPacket, now: string = new Date().toISOString()): Promise<EscalationTicket> {
      const id = ticketId(packet);
      const existing = await get(id);
      if (existing) return existing; // idempotent: re-queuing the same escalation is a no-op
      const ticket = openTicket(packet, now);
      const res = await doFetch(url(ticket.id), {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      if (!res.ok) throw new Error(`escalation-ticket PUT failed: ${res.status}`);
      return ticket;
    },
    get,
    async claim(): Promise<EscalationTicket> {
      throw new Error("httpEscalationSink: claim() is a reviewer action, not available via a sandboxed dispatch token");
    },
    async resolve(): Promise<EscalationTicket> {
      throw new Error("httpEscalationSink: resolve() is a reviewer action, not available via a sandboxed dispatch token");
    },
    async list(): Promise<EscalationTicket[]> {
      throw new Error("httpEscalationSink: list() would need to enumerate beyond this dispatch token's single-app scope");
    },
  } satisfies EscalationSink;
}
