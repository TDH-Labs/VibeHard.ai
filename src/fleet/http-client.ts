/**
 * httpFleetStore — a FleetStore that reaches the platform's durable, Postgres-backed fleet-
 * learning tables over a narrow, tokened HTTP endpoint. Sibling of substrate/record-client.ts,
 * substrate/secrets-client.ts, and escalation/http-client.ts; read store.ts's header first for
 * why this exists and how it differs from those three (global, not per-app scoped).
 *
 * Scope, deliberately narrower than the full FleetStore: a build sandbox only ever needs to READ
 * conventions (fleetBlock/loadConventions, at codegen/planning time) and READ+WRITE one candidate
 * at a time (recordCandidate/recordResolution, during the auto-fix loop). `putConvention` (adding
 * a NEW convention) and `listCandidates` (scanning all of them for promotion) are the operator's
 * `fleet approve`/`fleet induct` commands — those run with direct Postgres access (DATABASE_URL),
 * never from inside a sandboxed dispatch, so they throw here rather than being silently stubbed.
 */
import type { Candidate, Convention, FleetStore } from "./store.ts";

const CONVENTIONS_PATH = "/api/internal/fleet-conventions";
const CANDIDATES_PATH = "/api/internal/fleet-candidates";

export interface HttpFleetStoreOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export function httpFleetStore(opts: HttpFleetStoreOptions): FleetStore {
  const doFetch = opts.fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${opts.token}` };
  const candidateUrl = (key: string) => `${opts.baseUrl}${CANDIDATES_PATH}?key=${encodeURIComponent(key)}`;

  return {
    async getConventions(): Promise<Convention[]> {
      const res = await doFetch(`${opts.baseUrl}${CONVENTIONS_PATH}`, { headers: auth });
      if (!res.ok) throw new Error(`fleet-conventions GET failed: ${res.status}`);
      const body = (await res.json()) as { conventions: Convention[] };
      return body.conventions ?? [];
    },
    async putConvention(): Promise<void> {
      throw new Error("httpFleetStore: putConvention() is an operator action (fleet approve), not available via a sandboxed dispatch token");
    },
    async getCandidate(key: string): Promise<Candidate | null> {
      const res = await doFetch(candidateUrl(key), { headers: auth });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`fleet-candidates GET failed: ${res.status}`);
      const body = (await res.json()) as { candidate: Candidate | null };
      return body.candidate ?? null;
    },
    async putCandidate(c: Candidate): Promise<void> {
      const res = await doFetch(candidateUrl(c.key), {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ candidate: c }),
      });
      if (!res.ok) throw new Error(`fleet-candidates PUT failed: ${res.status}`);
    },
    async listCandidates(): Promise<Candidate[]> {
      throw new Error("httpFleetStore: listCandidates() is an operator action (fleet induct), not available via a sandboxed dispatch token");
    },
  };
}
