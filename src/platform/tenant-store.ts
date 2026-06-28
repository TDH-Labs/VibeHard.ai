/**
 * FileTenantStore — one JSON file per tenant under a directory (mirrors FileRecordStore).
 * The tenant registry; a platform DB drops in behind the TenantStore seam later.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tenant, TenantStore } from "./types.ts";

const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, "_");

export class FileTenantStore implements TenantStore {
  constructor(private readonly dir: string) {}

  private path(id: string): string {
    return join(this.dir, `${safeId(id)}.json`);
  }

  // Methods are async to satisfy the TenantStore seam (Postgres is async); the fs work is sync.
  async create(tenant: Tenant): Promise<void> {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    if (existsSync(this.path(tenant.id))) throw new Error(`tenant ${tenant.id} already exists`);
    writeFileSync(this.path(tenant.id), JSON.stringify(tenant, null, 2));
  }

  async get(id: string): Promise<Tenant | null> {
    const p = this.path(id);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Tenant;
    } catch {
      return null;
    }
  }

  async list(): Promise<Tenant[]> {
    if (!existsSync(this.dir)) return [];
    const out: Tenant[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Tenant);
      } catch {
        /* skip corrupt */
      }
    }
    return out;
  }

  async update(tenant: Tenant): Promise<void> {
    if (!existsSync(this.path(tenant.id))) throw new Error(`tenant ${tenant.id} not found`);
    writeFileSync(this.path(tenant.id), JSON.stringify(tenant, null, 2));
  }
}
