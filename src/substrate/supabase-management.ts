/**
 * Supabase Management API client — the AUTO-CREATE leg of the backend (vs the v1
 * "adopt an existing project"). This is what turns VibeHard from single-project into a
 * managed multi-tenant platform: each app gets its OWN Supabase project, provisioned
 * programmatically — the "VibeHard Cloud" model (cf. Lovable Cloud, but every project is
 * gated + live-RLS-verified before it's reachable).
 *
 * All HTTP is behind an injectable fetch seam + injectable sleep, so create/poll/keys
 * logic unit-tests with fakes — no live account, no billable project. The PAT is read from
 * SUPABASE_ACCESS_TOKEN (Supabase's own CLI convention) or SUPABASE_PAT, sent in the
 * Authorization header — NEVER logged. Shapes verified live 2026-06-22 against api.supabase.com.
 */
import { randomBytes } from "node:crypto";

const DEFAULT_API_BASE = "https://api.supabase.com";
export const DEFAULT_REGION = "us-east-1";

export interface ManagementClientOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface ProvisionRequest {
  name: string;
  region?: string; // default us-east-1
  orgId?: string; // default: the sole organization (auto-discovered) or SUPABASE_ORG_ID
  dbPassword?: string; // default: a freshly generated strong password
}

export interface ProvisionedProject {
  ref: string;
  url: string; // https://<ref>.supabase.co
  region: string;
  anonKey: string;
  serviceKey: string;
  dbHost: string; // the POOLER host from the Management API (authoritative — no aws-N guessing)
  dbUser: string; // postgres.<ref>
  dbPassword: string; // the password we set at creation — the caller MUST persist it (encrypted)
}

/** The PAT, by Supabase's own env convention or the alias the operator used. */
export function readManagementToken(): string {
  return process.env.SUPABASE_ACCESS_TOKEN ?? process.env.SUPABASE_PAT ?? "";
}

/** A strong, URL-safe DB password (base64url → no +/=@: that complicate connection URLs). */
export function generateDbPassword(): string {
  return `Dd_${randomBytes(24).toString("base64url")}`;
}

type ApiKeyEntry = { name: string; api_key: string };
type ProjectEntry = { id?: string; ref?: string; name?: string; region?: string; status?: string };
type PoolerEntry = { db_host?: string; db_user?: string };

export class SupabaseManagementClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ManagementClientOptions = {}) {
    this.token = opts.token ?? readManagementToken();
    if (!this.token) throw new Error("SupabaseManagementClient: missing SUPABASE_ACCESS_TOKEN (or SUPABASE_PAT)");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase Management ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  async listOrganizations(): Promise<Array<{ id: string; name: string }>> {
    const j = (await this.req("GET", "/v1/organizations")) as Array<{ id: string; name: string }> | null;
    return Array.isArray(j) ? j.map((o) => ({ id: o.id, name: o.name })) : [];
  }

  /** The given orgId, else the SOLE org, else throw (ambiguous → require SUPABASE_ORG_ID). */
  async resolveOrgId(preferred?: string): Promise<string> {
    if (preferred) return preferred;
    const orgs = await this.listOrganizations();
    if (orgs.length === 1) return orgs[0]!.id;
    if (orgs.length === 0) throw new Error("no Supabase organizations visible to this PAT");
    throw new Error(`multiple Supabase orgs (${orgs.map((o) => o.id).join(", ")}) — set SUPABASE_ORG_ID to choose`);
  }

  async createProject(req: { orgId: string; name: string; region: string; dbPassword: string }): Promise<{ ref: string; region: string }> {
    const j = (await this.req("POST", "/v1/projects", {
      organization_id: req.orgId,
      name: req.name,
      region: req.region,
      db_pass: req.dbPassword,
    })) as ProjectEntry;
    const ref = j.ref ?? j.id;
    if (!ref) throw new Error(`createProject: no project ref in response: ${JSON.stringify(j).slice(0, 200)}`);
    return { ref, region: j.region ?? req.region };
  }

  /** Poll until ACTIVE_HEALTHY (provisioning takes ~1–3 min). Throws on timeout. */
  async waitHealthy(ref: string, opts: { tries?: number; delayMs?: number } = {}): Promise<void> {
    const tries = opts.tries ?? 60;
    const delayMs = opts.delayMs ?? 5000;
    for (let i = 0; i < tries; i++) {
      const j = (await this.req("GET", `/v1/projects/${ref}`)) as ProjectEntry;
      if (j.status === "ACTIVE_HEALTHY") return;
      await this.sleep(delayMs);
    }
    throw new Error(`project ${ref} did not become ACTIVE_HEALTHY after ${tries} polls`);
  }

  async getApiKeys(ref: string): Promise<{ anonKey: string; serviceKey: string }> {
    const j = (await this.req("GET", `/v1/projects/${ref}/api-keys`)) as ApiKeyEntry[] | null;
    const find = (name: string): string => (Array.isArray(j) ? j.find((x) => x.name === name)?.api_key ?? "" : "");
    const anonKey = find("anon");
    const serviceKey = find("service_role");
    if (!anonKey || !serviceKey) {
      const names = Array.isArray(j) ? j.map((x) => x.name).join(", ") : "none";
      throw new Error(`getApiKeys(${ref}): missing anon/service_role (saw: ${names})`);
    }
    return { anonKey, serviceKey };
  }

  /** The pooler (Supavisor) host — authoritative from the API, so no aws-N shard guessing. */
  async getPoolerHost(ref: string): Promise<{ dbHost: string; dbUser: string }> {
    const j = (await this.req("GET", `/v1/projects/${ref}/config/database/pooler`)) as PoolerEntry[] | PoolerEntry | null;
    const e = Array.isArray(j) ? j[0] : j;
    if (!e?.db_host) throw new Error(`getPoolerHost(${ref}): no db_host in pooler config`);
    return { dbHost: e.db_host, dbUser: e.db_user ?? `postgres.${ref}` };
  }

  async deleteProject(ref: string): Promise<void> {
    await this.req("DELETE", `/v1/projects/${ref}`);
  }

  /** create → wait healthy → fetch keys + pooler host. Everything needed to migrate + deploy.
   *  If ANY step after creation fails, the project is half-provisioned (useless + billable) → we
   *  best-effort DELETE it so nothing leaks; if even that fails, the error names the ref so it's
   *  recoverable by hand. A provisioning hiccup must never silently leave a paid project behind. */
  async provisionProject(req: ProvisionRequest, waitOpts?: { tries?: number; delayMs?: number }): Promise<ProvisionedProject> {
    const orgId = await this.resolveOrgId(req.orgId ?? process.env.SUPABASE_ORG_ID);
    const region = req.region ?? DEFAULT_REGION;
    const dbPassword = req.dbPassword ?? generateDbPassword();
    const { ref } = await this.createProject({ orgId, name: req.name, region, dbPassword });
    try {
      await this.waitHealthy(ref, waitOpts);
      const { anonKey, serviceKey } = await this.getApiKeys(ref);
      const { dbHost, dbUser } = await this.getPoolerHost(ref);
      return { ref, url: `https://${ref}.supabase.co`, region, anonKey, serviceKey, dbHost, dbUser, dbPassword };
    } catch (e) {
      let cleanup = `deleted the orphaned project ${ref}`;
      try {
        await this.deleteProject(ref);
      } catch {
        cleanup = `COULD NOT delete orphaned project ${ref} — delete it manually to stop billing`;
      }
      throw new Error(`provisioning failed after creating ${ref}; ${cleanup}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
