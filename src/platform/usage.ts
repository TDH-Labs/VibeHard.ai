/**
 * UsageLedger — the durable, per-tenant record of metered events (project_created / build /
 * deploy). The billing STUB discards usage; this persists it append-only, tenant-isolated. A
 * Stripe-backed BillingProvider reads from / pushes this; the build-rate quota counts builds in
 * a window straight off `countSince`.
 *
 * Append-only logs grow without bound, so the ledger ROLLS BY MONTH: events land in
 * `<base>/tenants/<id>/usage/<YYYY-MM>.jsonl`. Each file is bounded to a month, `countSince`
 * reads only the month files inside its window (not the whole history), and old months can be
 * archived or dropped on a retention policy without touching recent data.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageEvent } from "./types.ts";

const safeSeg = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");
/** The month bucket for an ISO timestamp: "2026-06-23T…" → "2026-06". */
const monthOf = (iso: string): string => iso.slice(0, 7);

export interface UsageLedger {
  record(tenantId: string, event: UsageEvent): void;
  list(tenantId: string): UsageEvent[];
  /** Count events of a kind at or after an ISO timestamp (ISO sorts lexicographically = chronologically). */
  countSince(tenantId: string, kind: UsageEvent["kind"], sinceIso: string): number;
}

export class FileUsageLedger implements UsageLedger {
  constructor(private readonly baseDir: string) {}

  private dir(tenantId: string): string {
    return join(this.baseDir, "tenants", safeSeg(tenantId), "usage");
  }

  record(tenantId: string, event: UsageEvent): void {
    const dir = this.dir(tenantId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${monthOf(event.at)}.jsonl`), `${JSON.stringify(event)}\n`);
  }

  /** Every event, oldest month first (filenames sort chronologically). */
  list(tenantId: string): UsageEvent[] {
    return this.read(tenantId, () => true);
  }

  countSince(tenantId: string, kind: UsageEvent["kind"], sinceIso: string): number {
    const sinceMonth = monthOf(sinceIso);
    // Only read month files at/after the window's month — old months never touched.
    return this.read(tenantId, (month) => month >= sinceMonth).filter((e) => e.kind === kind && e.at >= sinceIso).length;
  }

  private read(tenantId: string, keepMonth: (month: string) => boolean): UsageEvent[] {
    const dir = this.dir(tenantId);
    if (!existsSync(dir)) return [];
    const out: UsageEvent[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
      if (!keepMonth(f.slice(0, -".jsonl".length))) continue;
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as UsageEvent);
        } catch {
          /* skip a corrupt line — never lose the whole ledger to one bad append */
        }
      }
    }
    return out;
  }
}
