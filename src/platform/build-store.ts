/**
 * Durable build-progress tracking (EPIC #33, closing the gap found 2026-07-03: a real build's
 * progress silently vanished after a machine restart — "No builds yet", with no error — because
 * active-build/build-history state lived ONLY in local JSON files under ~/.vibehard/tenants/,
 * completely separate from the Pg-backed tenant/deployment/secrets seams #33a-e already wired.
 * With no Fly volume attached, that local tree is wiped on every restart; the durable Postgres
 * connection (already proven working all session for tenants) was simply never asked to hold
 * this data. Same shape as PgRecordStore/PgSecretsStore (pg-store.ts): a JSON blob per scope, so
 * the record shape can evolve without a migration.
 *
 * Distinct from build.ts's BuildStore/FileBuildStore/BuildJob (the job-queue/quota control plane
 * used by Platform.submitBuild) — this is specifically the dashboard-facing "what's the tenant's
 * active build, what's their build history" state the /app SSE stream and "Your builds" list read.
 * Named BuildProgressStore to keep the two apart; imported directly (not through the barrel) by
 * web/server.ts, same as billing-webhook.ts already is.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "./pg-store.ts";

export type ActiveBuild = {
  app: string;
  prompt: string;
  status: "running" | "paused" | "live" | "blocked" | "deploy-failed" | "error";
};
export type BuildRecord = {
  app: string;
  prompt: string;
  status: ActiveBuild["status"];
  at: number;
  ticket?: string;
  url?: string;
};

/** Persistence for active-build + build-history tracking (file-backed v1; Pg durable v2, below). */
export interface BuildProgressStore {
  getActive(tenantId: string): Promise<ActiveBuild | null>;
  setActive(tenantId: string, build: ActiveBuild): Promise<void>;
  listBuilds(tenantId: string): Promise<BuildRecord[]>;
  appendBuild(tenantId: string, rec: BuildRecord): Promise<void>;
  patchBuild(tenantId: string, app: string, patch: Partial<BuildRecord>): Promise<void>;
  /** Every tenant id that has ANY tracked build — sweepStaleRunning's boot-time enumeration. */
  listTenantIds(): Promise<string[]>;
}

const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, "_");

/** File-backed default (today's behavior, unchanged) — durable only if the directory itself
 *  survives a restart (a mounted volume). Kept as the local-dev / no-DB fallback. */
export class FileBuildProgressStore implements BuildProgressStore {
  constructor(private readonly baseDir: string) {}

  private tenantDir(tenantId: string): string {
    return join(this.baseDir, "tenants", safeId(tenantId));
  }
  private activePath(tenantId: string): string {
    return join(this.tenantDir(tenantId), "active-build.json");
  }
  private buildsPath(tenantId: string): string {
    return join(this.tenantDir(tenantId), "builds.json");
  }

  async getActive(tenantId: string): Promise<ActiveBuild | null> {
    const p = this.activePath(tenantId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as ActiveBuild;
    } catch {
      return null;
    }
  }

  async setActive(tenantId: string, b: ActiveBuild): Promise<void> {
    mkdirSync(this.tenantDir(tenantId), { recursive: true });
    writeFileSync(this.activePath(tenantId), JSON.stringify(b, null, 2));
  }

  async listBuilds(tenantId: string): Promise<BuildRecord[]> {
    const p = this.buildsPath(tenantId);
    if (!existsSync(p)) return [];
    try {
      return JSON.parse(readFileSync(p, "utf8")) as BuildRecord[];
    } catch {
      return [];
    }
  }

  private async saveBuilds(tenantId: string, list: BuildRecord[]): Promise<void> {
    mkdirSync(this.tenantDir(tenantId), { recursive: true });
    writeFileSync(this.buildsPath(tenantId), JSON.stringify(list.slice(0, 50), null, 2));
  }

  async appendBuild(tenantId: string, rec: BuildRecord): Promise<void> {
    const list = await this.listBuilds(tenantId);
    list.unshift(rec);
    await this.saveBuilds(tenantId, list);
  }

  async patchBuild(tenantId: string, app: string, patch: Partial<BuildRecord>): Promise<void> {
    const list = await this.listBuilds(tenantId);
    const i = list.findIndex((b) => b.app === app);
    if (i >= 0) {
      list[i] = { ...list[i]!, ...patch };
      await this.saveBuilds(tenantId, list);
    }
  }

  async listTenantIds(): Promise<string[]> {
    const tdir = join(this.baseDir, "tenants");
    if (!existsSync(tdir)) return [];
    return readdirSync(tdir);
  }
}

/** Substrate tables for build-progress tracking. Idempotent — safe to call on every boot, same
 *  as the other ensure*Schema functions in pg-store.ts (called alongside them from db.ts). */
export async function ensureBuildSchema(sql: Sql): Promise<void> {
  await sql(`create table if not exists active_builds (scope text primary key, data text not null)`);
  await sql(`create table if not exists tenant_builds (scope text primary key, data text not null)`);
}

/**
 * Postgres-backed build-progress tracking — the async durable equivalent of
 * FileBuildProgressStore. Scoped per tenant like PgRecordStore/PgSecretsStore, but ONE store
 * instance serves every tenant (tenantId is a per-call argument, not a constructor field) —
 * matching web/server.ts's existing call shape (readActiveBuild(tenantId), not a store bound to
 * one tenant) so the call sites barely change.
 */
export class PgBuildProgressStore implements BuildProgressStore {
  constructor(private readonly sql: Sql) {}

  async getActive(tenantId: string): Promise<ActiveBuild | null> {
    const rows = await this.sql(`select data from active_builds where scope = $1`, [tenantId]);
    if (!rows[0]) return null;
    try {
      return JSON.parse(String(rows[0].data)) as ActiveBuild;
    } catch {
      return null;
    }
  }

  async setActive(tenantId: string, b: ActiveBuild): Promise<void> {
    await this.sql(
      `insert into active_builds (scope, data) values ($1, $2)
       on conflict (scope) do update set data = excluded.data`,
      [tenantId, JSON.stringify(b)],
    );
  }

  async listBuilds(tenantId: string): Promise<BuildRecord[]> {
    const rows = await this.sql(`select data from tenant_builds where scope = $1`, [tenantId]);
    if (!rows[0]) return [];
    try {
      return JSON.parse(String(rows[0].data)) as BuildRecord[];
    } catch {
      return [];
    }
  }

  private async saveBuilds(tenantId: string, list: BuildRecord[]): Promise<void> {
    await this.sql(
      `insert into tenant_builds (scope, data) values ($1, $2)
       on conflict (scope) do update set data = excluded.data`,
      [tenantId, JSON.stringify(list.slice(0, 50))],
    );
  }

  async appendBuild(tenantId: string, rec: BuildRecord): Promise<void> {
    const list = await this.listBuilds(tenantId);
    list.unshift(rec);
    await this.saveBuilds(tenantId, list);
  }

  async patchBuild(tenantId: string, app: string, patch: Partial<BuildRecord>): Promise<void> {
    const list = await this.listBuilds(tenantId);
    const i = list.findIndex((b) => b.app === app);
    if (i >= 0) {
      list[i] = { ...list[i]!, ...patch };
      await this.saveBuilds(tenantId, list);
    }
  }

  async listTenantIds(): Promise<string[]> {
    const rows = await this.sql(`select distinct scope from active_builds`);
    return rows.map((r) => String(r.scope));
  }
}
