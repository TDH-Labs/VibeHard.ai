/**
 * LocalBillingProvider — the billing SEAM's stub. The plan is whatever the tenant record says;
 * usage events go to an optional sink (default: discarded). A Stripe-backed BillingProvider —
 * map a subscription to a plan, push metered usage records — drops in behind this same interface
 * without the platform logic changing. This is the "ready to wire to real Stripe" placeholder.
 */
import type { BillingProvider, Plan, Tenant, UsageEvent } from "./types.ts";
import { planFor } from "./plans.ts";

export class LocalBillingProvider implements BillingProvider {
  readonly name = "local-stub";

  constructor(private readonly onUsage?: (tenantId: string, event: UsageEvent) => void) {}

  planFor(tenant: Tenant): Plan {
    return planFor(tenant);
  }

  async recordUsage(tenantId: string, event: UsageEvent): Promise<void> {
    this.onUsage?.(tenantId, event);
  }
}
