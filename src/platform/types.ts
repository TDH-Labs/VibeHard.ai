/**
 * Platform layer (multi-tenant) — sits ABOVE the substrate. The substrate deploys ONE app;
 * the platform makes many unrelated tenants each run many apps, isolated from one another,
 * within plan quotas. v1 isolation is filesystem-level (each tenant gets its own state dir,
 * so their deployment records + encrypted secrets live nowhere near another tenant's); a
 * multi-tenant DB with row scoping drops in behind the same TenantStore/RecordStore seams later.
 *
 * Billing is a SEAM here, not an implementation: the stub reads the tenant's plan and discards
 * usage; a Stripe-backed provider (subscription→plan, metered usage records) wires in unchanged.
 */
export type TenantStatus = "active" | "suspended";

/** A signed-up customer (the BUILDER) — distinct from the end-users of the apps they build. */
export interface Tenant {
  id: string;
  name: string;
  plan: string; // key into PLANS
  status: TenantStatus;
  createdAt: string;
}

/** A subscription tier and the limits it grants. */
export interface Plan {
  name: string;
  maxProjects: number; // how many apps the tenant may have at once
  maxBuildsPerDay: number; // build-rate cap (enforced by the build sandbox later; carried here)
}

/** Persistence for Tenants. Async so a durable Postgres store (PgTenantStore) drops in behind the
 *  same seam as the file-backed local store; both await the same way. */
export interface TenantStore {
  create(tenant: Tenant): Promise<void>;
  get(id: string): Promise<Tenant | null>;
  list(): Promise<Tenant[]>;
  update(tenant: Tenant): Promise<void>;
}

/** A metered event for billing (stub discards; Stripe usage records later). */
export interface UsageEvent {
  kind: "project_created" | "build" | "deploy";
  app?: string;
  at: string;
}

/** Billing SEAM. Stub = plan from the tenant record, usage discarded. Stripe impl drops in here. */
export interface BillingProvider {
  readonly name: string;
  planFor(tenant: Tenant): Plan;
  recordUsage(tenantId: string, event: UsageEvent): Promise<void>;
}
