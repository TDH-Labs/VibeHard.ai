/**
 * Platform — the multi-tenant entry point. Sign up tenants, and deploy apps FOR a tenant:
 * quota-checked and isolated in the tenant's own state directory (so one tenant's deployment
 * records + encrypted secrets are physically separate from every other tenant's). The deploy
 * itself is delegated to the substrate's deployApp; the platform only adds tenancy + quotas +
 * usage metering on top. The deploy fn is injectable so this logic unit-tests without a live
 * provision (the substrate is already proven separately).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { deployApp, type DeployAppOptions } from "../substrate/deploy-app.ts";
import type { DeployOutcome } from "../substrate/orchestrator.ts";
import { LocalBillingProvider } from "./billing.ts";
import { FileTenantStore } from "./tenant-store.ts";
import { FileUsageLedger, type UsageLedger } from "./usage.ts";
import { dayAgo, FileBuildStore, type BuildJob, type BuildRunner, type BuildStore } from "./build.ts";
import { DEFAULT_PLAN } from "./plans.ts";
import type { BillingProvider, Tenant, TenantStore, UsageEvent } from "./types.ts";

const safeSeg = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");

/** The deploy seam — the real one is the substrate's deployApp; tests inject a fake. */
export type DeployFn = (workspacePath: string, opts?: DeployAppOptions) => Promise<DeployOutcome>;

export interface PlatformOptions {
  baseDir?: string; // default ~/.drydock
  tenants?: TenantStore;
  billing?: BillingProvider;
  ledger?: UsageLedger; // durable usage record (default: FileUsageLedger under baseDir)
  builds?: BuildStore; // build-job records (default: FileBuildStore under baseDir)
  deploy?: DeployFn; // default: the substrate deployApp
  now?: () => string; // injectable clock (testability)
  newId?: () => string; // injectable id generator (testability)
}

export class Platform {
  private readonly baseDir: string;
  private readonly tenants: TenantStore;
  private readonly billing: BillingProvider;
  private readonly ledger: UsageLedger;
  private readonly builds: BuildStore;
  private readonly deploy: DeployFn;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(opts: PlatformOptions = {}) {
    this.baseDir = opts.baseDir ?? join(homedir(), ".drydock");
    this.tenants = opts.tenants ?? new FileTenantStore(join(this.baseDir, "tenants"));
    this.billing = opts.billing ?? new LocalBillingProvider();
    this.ledger = opts.ledger ?? new FileUsageLedger(this.baseDir);
    this.builds = opts.builds ?? new FileBuildStore(this.baseDir);
    this.deploy = opts.deploy ?? deployApp;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.newId = opts.newId ?? (() => randomUUID());
  }

  /** Meter a usage event: persist it to the durable ledger AND push it to the billing seam. */
  private async meter(tenantId: string, event: UsageEvent): Promise<void> {
    this.ledger.record(tenantId, event);
    await this.billing.recordUsage(tenantId, event);
  }

  /** A tenant's recorded usage (the durable ledger). */
  usage(tenantId: string): UsageEvent[] {
    return this.ledger.list(tenantId);
  }

  /** Count a tenant's usage of a kind since an ISO timestamp (e.g. builds in the last 24h). */
  usageCountSince(tenantId: string, kind: UsageEvent["kind"], sinceIso: string): number {
    return this.ledger.countSince(tenantId, kind, sinceIso);
  }

  /** A tenant's ISOLATED state directory — their deployments + secrets live here and nowhere else. */
  stateDir(tenantId: string): string {
    return join(this.baseDir, "tenants", safeSeg(tenantId));
  }

  /** Sign up a new tenant (the builder). Returns the created record. */
  signUp(name: string, plan: string = DEFAULT_PLAN): Tenant {
    const tenant: Tenant = { id: this.newId(), name, plan, status: "active", createdAt: this.now() };
    this.tenants.create(tenant);
    return tenant;
  }

  getTenant(id: string): Tenant | null {
    return this.tenants.get(id);
  }

  listTenants(): Tenant[] {
    return this.tenants.list();
  }

  private mutate(id: string, fn: (t: Tenant) => Tenant): Tenant {
    const t = this.tenants.get(id);
    if (!t) throw new Error(`unknown tenant ${id}`);
    const next = fn(t);
    this.tenants.update(next);
    return next;
  }

  /** Tenant lifecycle: suspend (blocks deploys), resume, or change plan (changes the quota). */
  suspend(tenantId: string): Tenant {
    return this.mutate(tenantId, (t) => ({ ...t, status: "suspended" }));
  }
  resume(tenantId: string): Tenant {
    return this.mutate(tenantId, (t) => ({ ...t, status: "active" }));
  }
  setPlan(tenantId: string, plan: string): Tenant {
    return this.mutate(tenantId, (t) => ({ ...t, plan }));
  }

  /** Count a tenant's ACTIVE projects (deployment records, excluding failed/destroyed). A failed
   *  deploy doesn't occupy a quota slot — provisioning already best-effort-cleans its resources,
   *  so a transient failure shouldn't permanently block a free-tier tenant. */
  projectCount(tenantId: string): number {
    const dir = join(this.stateDir(tenantId), "deployments");
    if (!existsSync(dir)) return 0;
    let n = 0;
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        let status: string | undefined;
        try {
          status = (JSON.parse(readFileSync(join(dir, f), "utf8")) as { status?: string }).status;
        } catch {
          /* unreadable record → count it (conservative) */
        }
        if (status !== "failed" && status !== "destroyed") n++;
      }
    } catch {
      return 0;
    }
    return n;
  }

  /**
   * Enforce tenant status + plan quota. A REDEPLOY of an existing app is always allowed; only a
   * NEW app counts against maxProjects. Throws (not returns) on violation — fail closed.
   */
  assertCanDeploy(tenantId: string, app: string): void {
    const t = this.tenants.get(tenantId);
    if (!t) throw new Error(`unknown tenant ${tenantId}`);
    if (t.status !== "active") throw new Error(`tenant ${tenantId} is ${t.status} — cannot deploy`);
    const plan = this.billing.planFor(t);
    const isExisting = existsSync(join(this.stateDir(tenantId), "deployments", `${safeSeg(app)}.json`));
    if (!isExisting && this.projectCount(tenantId) >= plan.maxProjects) {
      throw new Error(`quota exceeded: plan "${plan.name}" allows ${plan.maxProjects} project(s) — upgrade to add more`);
    }
  }

  /**
   * Deploy an app FOR a tenant: quota-checked, in the tenant's isolated state dir, with a usage
   * event recorded. Everything the substrate needs (managed vs adopt, host selection) still applies.
   */
  async deployForTenant(
    tenantId: string,
    workspacePath: string,
    opts: Omit<DeployAppOptions, "stateDir" | "deps"> = {},
  ): Promise<DeployOutcome> {
    const app = opts.app ?? basename(workspacePath);
    this.assertCanDeploy(tenantId, app);
    // FORCE managed: every tenant app gets its OWN auto-provisioned project in its OWN isolated
    // dir — never the operator's shared project (which a global DRYDOCK_MANAGED flag couldn't guarantee).
    const outcome = await this.deploy(workspacePath, { ...opts, app, stateDir: this.stateDir(tenantId), managed: true });
    await this.meter(tenantId, { kind: "deploy", app, at: this.now() });
    return outcome;
  }

  /**
   * Accept a build for a tenant: enforce status + the daily build-rate quota (counted off the
   * usage ledger), queue a job, and meter a "build" event (which the window then counts). Throws
   * on a suspended/unknown tenant or an exceeded rate — fail closed, BEFORE any work runs.
   */
  async submitBuild(tenantId: string, app: string, workspacePath?: string): Promise<BuildJob> {
    const t = this.tenants.get(tenantId);
    if (!t) throw new Error(`unknown tenant ${tenantId}`);
    if (t.status !== "active") throw new Error(`tenant ${tenantId} is ${t.status} — cannot build`);
    const plan = this.billing.planFor(t);
    const usedToday = this.ledger.countSince(tenantId, "build", dayAgo(this.now()));
    if (usedToday >= plan.maxBuildsPerDay) {
      throw new Error(`build rate limit: plan "${plan.name}" allows ${plan.maxBuildsPerDay} builds/day (used ${usedToday})`);
    }
    const job: BuildJob = { id: this.newId(), tenantId, app, status: "queued", queuedAt: this.now(), ...(workspacePath ? { workspacePath } : {}) };
    this.builds.put(job);
    await this.meter(tenantId, { kind: "build", app, at: this.now() });
    return job;
  }

  /** Run a queued job through the (injected) runner — the real one executes in a sandbox. The
   *  control plane only drives the state machine + persists the outcome (never throws on a failed
   *  build; a thrown runner becomes a failed job). */
  async runBuild(job: BuildJob, runner: BuildRunner): Promise<BuildJob> {
    let j: BuildJob = { ...job, status: "running", startedAt: this.now() };
    this.builds.put(j);
    try {
      const res = await runner.run(j);
      j = { ...j, status: res.ok ? "succeeded" : "failed", finishedAt: this.now(), ...(res.error ? { error: res.error } : {}) };
    } catch (e) {
      j = { ...j, status: "failed", finishedAt: this.now(), error: e instanceof Error ? e.message : String(e) };
    }
    this.builds.put(j);
    return j;
  }

  /** Submit (quota-checked) + run, in one call. */
  async build(tenantId: string, app: string, runner: BuildRunner, workspacePath?: string): Promise<BuildJob> {
    return this.runBuild(await this.submitBuild(tenantId, app, workspacePath), runner);
  }

  listBuilds(tenantId: string): BuildJob[] {
    return this.builds.list(tenantId);
  }
}
