/** Platform layer (multi-tenant) — barrel export. */
export type { Tenant, TenantStatus, Plan, TenantStore, BillingProvider, UsageEvent } from "./types.ts";
export { PLANS, DEFAULT_PLAN, planFor } from "./plans.ts";
export { FileTenantStore } from "./tenant-store.ts";
export { LocalBillingProvider } from "./billing.ts";
export { Platform, type PlatformOptions, type DeployFn } from "./platform.ts";
