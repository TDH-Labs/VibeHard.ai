/**
 * Plan registry — the tiers and their limits. Deliberately small + boring; the real pricing
 * lives in product/billing, not here. A tenant references a plan by name; unknown → free.
 */
import type { Plan, Tenant } from "./types.ts";

export const PLANS: Record<string, Plan> = {
  free: { name: "free", maxProjects: 1, maxBuildsPerDay: 10 },
  starter: { name: "starter", maxProjects: 5, maxBuildsPerDay: 50 },
  pro: { name: "pro", maxProjects: 25, maxBuildsPerDay: 250 },
};

export const DEFAULT_PLAN = "free";

/** The tenant's plan, falling back to free for an unknown/missing plan name. */
export function planFor(tenant: Pick<Tenant, "plan">): Plan {
  return PLANS[tenant.plan] ?? PLANS[DEFAULT_PLAN]!;
}
