/**
 * httpSecretsStore — a SecretsStore that reaches the platform's durable, encrypted-at-rest
 * backend secrets over a narrow, tokened HTTP endpoint. Direct sibling of record-client.ts;
 * read that file's header first — same architecture, same reasoning, one layer deeper.
 *
 * THE BUG THIS CLOSES (found live 2026-07-19, acceptance test prompt C — three ship attempts in
 * a row aborted at verify-live-rls with the IDENTICAL "could not prove RLS" for the SAME three
 * tables, even after the live-RLS retry budget was widened to ~190s per table — ~9.5 minutes of
 * wall-clock spent retrying something a bounded retry could never fix). Root cause: the record-
 * store fix (httpRecordStore) made `projectRef`/`appliedMigrations`/`hostRef` durable across
 * sandboxes, but `ensureProject`'s REUSE path also needs the project's full connection —
 * url/anonKey/serviceKey/dbHost/dbPassword — from `this.secretsStore`, which (like the record
 * store before it) defaulted to `LocalEncryptedSecretsStore` under `~/.vibehard/secrets`: a path
 * outside the workspace, gone the instant the sandbox tears down. On a REUSE, that store's
 * `get(app)` returns null in the fresh sandbox, so `ensureProject` silently fell through to
 * `this.env` at its EMPTY constructor default (`{ url: "", anonKey: "", serviceKey: "" }`) —
 * verifyLiveRls then probed `"" + "/rest/v1/teams..."`, a URL with no host, on EVERY attempt,
 * for the ENTIRE retry budget, no amount of waiting could ever have fixed it. applyMigrations
 * masked this: with every migration already recorded applied (via the WORKING record store), its
 * `todo` list was empty and it returned success WITHOUT ever touching `this.env` at all.
 *
 * Same trust boundary as the sandbox already has for its OWN app's secrets during CREATION
 * (SupabaseBackendProvider holds serviceKey/dbPassword in-memory mid-deploy already) — this only
 * makes that same data durable across a redeploy, via the same scoped channel as the deployment
 * record. Encrypted at rest server-side (PgSecretsStore/sealJson); never a raw DB connection into
 * the sandbox.
 */
import type { BackendSecrets, SecretsStore } from "./types.ts";

const PATH = "/api/internal/backend-secrets";

export interface HttpSecretsStoreOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export function httpSecretsStore(opts: HttpSecretsStoreOptions): SecretsStore {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = (app: string) => `${opts.baseUrl}${PATH}?app=${encodeURIComponent(app)}`;
  const auth = { Authorization: `Bearer ${opts.token}` };
  return {
    name: "http-secrets",
    async get(app: string): Promise<BackendSecrets | null> {
      const res = await doFetch(url(app), { headers: auth });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`backend-secrets GET failed: ${res.status}`);
      const body = (await res.json()) as { secrets: BackendSecrets | null };
      return body.secrets ?? null;
    },
    async put(app: string, secrets: BackendSecrets): Promise<string> {
      const res = await doFetch(url(app), {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ secrets }),
      });
      if (!res.ok) throw new Error(`backend-secrets PUT failed: ${res.status}`);
      return app;
    },
    async remove(app: string): Promise<void> {
      const res = await doFetch(url(app), { method: "DELETE", headers: auth });
      if (!res.ok && res.status !== 404) throw new Error(`backend-secrets DELETE failed: ${res.status}`);
    },
  };
}
