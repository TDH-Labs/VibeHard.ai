/**
 * Build control plane — the seam-testable half of the build sandbox. It owns the build JOB
 * (queue → run → terminal state), per-tenant build records, and the daily build-rate quota
 * (counted off the usage ledger). The actual EXECUTION (codegen + gate) is a BuildRunner seam:
 * the real one runs in an isolated, resource-capped container; injected here so the control
 * plane tests without that infrastructure. The container runtime drops in behind BuildRunner.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type BuildStatus = "queued" | "running" | "succeeded" | "failed";

export interface BuildJob {
  id: string;
  tenantId: string;
  app: string;
  status: BuildStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/** The actual build execution. Real impl = an isolated sandbox container; injected for tests. */
export interface BuildRunner {
  run(job: BuildJob): Promise<{ ok: boolean; error?: string }>;
}

/** Persistence for build jobs (file-backed v1; platform DB later). */
export interface BuildStore {
  put(job: BuildJob): void;
  get(tenantId: string, id: string): BuildJob | null;
  list(tenantId: string): BuildJob[];
}

const safeSeg = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");

export class FileBuildStore implements BuildStore {
  constructor(private readonly baseDir: string) {}

  private dir(tenantId: string): string {
    return join(this.baseDir, "tenants", safeSeg(tenantId), "builds");
  }

  put(job: BuildJob): void {
    const d = this.dir(job.tenantId);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${safeSeg(job.id)}.json`), JSON.stringify(job, null, 2));
  }

  get(tenantId: string, id: string): BuildJob | null {
    const p = join(this.dir(tenantId), `${safeSeg(id)}.json`);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as BuildJob;
    } catch {
      return null;
    }
  }

  list(tenantId: string): BuildJob[] {
    const d = this.dir(tenantId);
    if (!existsSync(d)) return [];
    const out: BuildJob[] = [];
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(d, f), "utf8")) as BuildJob);
      } catch {
        /* skip corrupt */
      }
    }
    return out;
  }
}

/** ISO timestamp 24h before `nowIso` — the start of the daily build-rate window. */
export function dayAgo(nowIso: string): string {
  return new Date(Date.parse(nowIso) - 24 * 60 * 60 * 1000).toISOString();
}
