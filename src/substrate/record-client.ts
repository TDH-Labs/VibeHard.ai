/**
 * httpRecordStore — a RecordStore that reaches the platform's durable, Postgres-backed
 * deployment records over a narrow, tokened HTTP endpoint, for callers with NO direct DB access.
 *
 * THE BUG THIS CLOSES (found live 2026-07-19, acceptance test prompt C — repeated ship attempts
 * for the SAME app each created a BRAND NEW Supabase project, eventually exhausting the org's
 * free-tier project quota): `cli.ts ship` is the only caller of `deployApp`, and it runs as a
 * bare subprocess — on the platform host directly, OR (in production, VIBEHARD_BUILD_WORKER=e2b)
 * inside a fresh, ephemeral E2B sandbox with no live DB connection of its own. Without an
 * explicit `sql`, `defaultSubstrateDeps` falls back to `FileRecordStore` under `~/.vibehard/
 * deployments` — a path OUTSIDE the workspace directory the build-worker's checkpoint tars, so
 * it never survives a sandbox teardown. Every sandboxed ship therefore saw `record.projectRef`
 * as null and treated itself as the app's FIRST deploy, forever — `provisionAndDeploy` calls
 * `ensureProject` with `reuse=false` every single time, in production, for every tenant, since
 * the day E2B dispatch went live. This isn't a resource-quota bug; it's a data-loss/orphaned-
 * infrastructure bug (a redeploy abandons the previous backend and its data).
 *
 * The fix does NOT hand the sandbox a raw Postgres connection — `build-env.ts`'s own header
 * comment is explicit that spreading DB credentials into a multi-tenant sandbox is exactly the
 * blast radius this architecture exists to avoid. Instead this mirrors the EXISTING checkpoint-
 * ping pattern (build-worker.ts's `CHECKPOINT_PING_PATH`): a reusable, already-minted dispatch
 * token (DispatchTokenStore — "resolving it only ever reveals which (tenantId, app) a token
 * belongs to, never a credential") scopes a narrow read/write of exactly ONE app's own
 * DeploymentRecord, via `/api/internal/deployment-record` on the platform.
 */
import type { DeploymentRecord, RecordStore } from "./types.ts";

const PATH = "/api/internal/deployment-record";

export interface HttpRecordStoreOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export function httpRecordStore(opts: HttpRecordStoreOptions): RecordStore {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = (app: string) => `${opts.baseUrl}${PATH}?app=${encodeURIComponent(app)}`;
  const auth = { Authorization: `Bearer ${opts.token}` };
  return {
    async get(app: string): Promise<DeploymentRecord | null> {
      const res = await doFetch(url(app), { headers: auth });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`deployment-record GET failed: ${res.status}`);
      const body = (await res.json()) as { record: DeploymentRecord | null };
      return body.record ?? null;
    },
    async put(record: DeploymentRecord): Promise<void> {
      const res = await doFetch(url(record.app), {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ record }),
      });
      if (!res.ok) throw new Error(`deployment-record PUT failed: ${res.status}`);
    },
    async remove(app: string): Promise<void> {
      const res = await doFetch(url(app), { method: "DELETE", headers: auth });
      if (!res.ok && res.status !== 404) throw new Error(`deployment-record DELETE failed: ${res.status}`);
    },
  };
}
