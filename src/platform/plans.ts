/**
 * Plan registry — the tiers and their limits. Deliberately small + boring; the real pricing
 * lives in product/billing, not here. A tenant references a plan by name; unknown → free.
 */
import type { Plan, Tenant } from "./types.ts";

export const PLANS: Record<string, Plan> = {
  // Turnkey economics: every build burns the PLATFORM's LLM tokens (a full spec→codegen→gates→
  // autofix run costs real dollars), so per-day caps are the cost ceiling per tenant. Sized so a
  // plan's worst-case monthly token bill stays comfortably under its price; loosen these only
  // once real per-build cost is measured or credit metering (EPIC #36) lands. A tenant on their
  // OWN key (BYO, Advanced) isn't spending platform tokens — same caps still apply for abuse.
  free: { name: "free", maxProjects: 1, maxBuildsPerDay: 2 },
  starter: { name: "starter", maxProjects: 5, maxBuildsPerDay: 5 },
  pro: { name: "pro", maxProjects: 25, maxBuildsPerDay: 20 },
};

export const DEFAULT_PLAN = "free";

/** The tenant's plan, falling back to free for an unknown/missing plan name. */
export function planFor(tenant: Pick<Tenant, "plan">): Plan {
  return PLANS[tenant.plan] ?? PLANS[DEFAULT_PLAN]!;
}
