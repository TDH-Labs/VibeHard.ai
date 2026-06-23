/**
 * UsageLedger — the durable, per-tenant record of metered events (project_created / build /
 * deploy). The billing STUB discards usage; this persists it append-only (JSONL), tenant-isolated
 * like everything else (`<base>/tenants/<id>/usage.jsonl`). A Stripe-backed BillingProvider reads
 * from / pushes this; the build-rate quota counts builds in a window straight off `countSince`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UsageEvent } from "./types.ts";

const safeSeg = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");

export interface UsageLedger {
  record(tenantId: string, event: UsageEvent): void;
  list(tenantId: string): UsageEvent[];
  /** Count events of a kind at or after an ISO timestamp (ISO sorts lexicographically = chronologically). */
  countSince(tenantId: string, kind: UsageEvent["kind"], sinceIso: string): number;
}

export class FileUsageLedger implements UsageLedger {
  constructor(private readonly baseDir: string) {}

  private path(tenantId: string): string {
    return join(this.baseDir, "tenants", safeSeg(tenantId), "usage.jsonl");
  }

  record(tenantId: string, event: UsageEvent): void {
    const p = this.path(tenantId);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify(event)}\n`);
  }

  list(tenantId: string): UsageEvent[] {
    const p = this.path(tenantId);
    if (!existsSync(p)) return [];
    const out: UsageEvent[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as UsageEvent);
      } catch {
        /* skip a corrupt line — never lose the whole ledger to one bad append */
      }
    }
    return out;
  }

  countSince(tenantId: string, kind: UsageEvent["kind"], sinceIso: string): number {
    return this.list(tenantId).filter((e) => e.kind === kind && e.at >= sinceIso).length;
  }
}
