/**
 * Fly Machines lifecycle for hosted agents (AHP-4) — the genuinely new compute
 * capability the scoping doc named: long-lived, per-customer agent processes. NOT the
 * E2B build sandbox (ephemeral, 1h hard cap) and NOT FlyHostProvider (per-app
 * Dockerfile deploys for generated web apps): agent Machines run the PLATFORM'S OWN
 * prebuilt agent-runtime image (docker/agent-runtime/) with per-machine config, via
 * the Machines REST API (api.machines.dev/v1) behind an injectable HTTP seam.
 *
 * Topology: one Fly app per customer account (`vh-agents-<accountSlug>`) — the account
 * is the blast-radius + billing-attribution boundary. Placement (the honest pricing
 * lever, CONTRACTS.md §compute):
 *   shared   → ONE Machine running a supervisor with one buzz-acp process per agent
 *              identity (memory scales with agent count; a crash restarts the set).
 *   isolated → one Machine per agent (a crash restarts only that agent).
 *
 * Secrets posture (v1): the agent's BUZZ_PRIVATE_KEY rides in machine config env —
 * readable only via our org-scoped FLY_API_TOKEN, the same trust boundary that could
 * read any app secret we set. At-rest custody stays in the platform SecretsStore;
 * KMS-grade delivery upgrades with EPIC #35. Documented, not hidden.
 *
 * Pack delivery: the persona pack (KBs of text) travels as a base64 tarball in machine
 * env (PACK_TGZ_B64), unpacked by the image entrypoint. A size guard fails closed at
 * 24KB encoded — past that we move to object storage, not to a bigger env var.
 */
import type { AccountConfig, AgentLaunchPlan } from "./types.ts";

export interface FlyHttpResponse {
  status: number;
  json: unknown;
}
/** Injectable HTTP seam (fake in unit tests; realFlyHttp in production). */
export type FlyHttp = (method: string, path: string, body?: unknown) => Promise<FlyHttpResponse>;

export function realFlyHttp(token: string, baseUrl = "https://api.machines.dev/v1"): FlyHttp {
  return async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* some endpoints return empty bodies */
    }
    return { status: res.status, json };
  };
}

export interface AgentMachine {
  id: string;
  name: string;
  state: string; // started | stopped | destroyed | ... (Fly's vocabulary, passed through)
}

export interface MachineManagerOptions {
  http: FlyHttp;
  orgSlug: string;
  region?: string; // default iad — same default as the rest of the platform
  /** The prebuilt agent-runtime image ref (registry.fly.io/... or public). */
  image: string;
  /** Memory per agent PROCESS; a shared Machine gets perAgentMemoryMb × agents. */
  perAgentMemoryMb?: number;
}

export const APP_PREFIX = "vh-agents-";
export const appNameFor = (accountSlug: string): string => `${APP_PREFIX}${accountSlug}`;
const MAX_PACK_ENV_BYTES = 24 * 1024;

/** What the entrypoint/supervisor reads (docker/agent-runtime/entrypoint.sh):
 *  one entry per buzz-acp process on this Machine. The key env VAR NAME is per-agent
 *  (AGENT_KEY_<NAME>) so one shared Machine can carry N keys without collision; the
 *  supervisor maps each to BUZZ_PRIVATE_KEY for its child process only. */
interface SupervisorAgentSpec {
  name: string;
  keyEnvVar: string;
  args: string[];
  env: Record<string, string>;
}

export const keyEnvVarFor = (agentName: string): string => `AGENT_KEY_${agentName.replace(/-/g, "_").toUpperCase()}`;

/** Build one Machine's config (the Machines-API `config` object). Pure. */
export function machineConfig(
  opts: { image: string; perAgentMemoryMb: number },
  agents: AgentLaunchPlan[],
  agentKeys: Record<string, string>,
  packTgzB64: string,
): Record<string, unknown> {
  if (packTgzB64.length > MAX_PACK_ENV_BYTES) {
    throw new Error(`persona pack tarball is ${packTgzB64.length}B encoded — over the ${MAX_PACK_ENV_BYTES}B env budget; move pack delivery to object storage before growing packs this large`);
  }
  const specs: SupervisorAgentSpec[] = agents.map((p) => ({ name: p.agentName, keyEnvVar: keyEnvVarFor(p.agentName), args: p.args, env: p.env }));
  const keyEnv: Record<string, string> = {};
  for (const p of agents) {
    const key = agentKeys[p.agentName];
    if (!key) throw new Error(`missing private key for agent "${p.agentName}"`);
    keyEnv[keyEnvVarFor(p.agentName)] = key;
  }
  return {
    image: opts.image,
    env: {
      AGENTS_JSON: JSON.stringify(specs),
      PACK_TGZ_B64: packTgzB64,
      ...keyEnv,
    },
    guest: { cpu_kind: "shared", cpus: 1, memory_mb: Math.max(512, opts.perAgentMemoryMb * agents.length) },
    restart: { policy: "always" },
    auto_destroy: false,
  };
}

export class AgentMachineManager {
  private readonly http: FlyHttp;
  private readonly orgSlug: string;
  private readonly region: string;
  private readonly image: string;
  private readonly perAgentMemoryMb: number;

  constructor(opts: MachineManagerOptions) {
    this.http = opts.http;
    this.orgSlug = opts.orgSlug;
    this.region = opts.region ?? "iad";
    this.image = opts.image;
    this.perAgentMemoryMb = opts.perAgentMemoryMb ?? 768;
  }

  /** Idempotent app ensure: 201 created, or already-exists (Fly answers 422) → fine. */
  private async ensureApp(app: string): Promise<void> {
    const r = await this.http("POST", "/apps", { app_name: app, org_slug: this.orgSlug });
    if (r.status >= 200 && r.status < 300) return;
    if (r.status === 422) return; // already exists — idempotent re-provision
    throw new Error(`fly app create ${app} failed (${r.status}): ${JSON.stringify(r.json).slice(0, 300)}`);
  }

  /** Provision (or re-provision) the account's fleet. Returns created machine ids by
   *  group name. Shared placement → one "fleet" Machine; isolated → one per agent. */
  async provision(cfg: AccountConfig, plans: AgentLaunchPlan[], agentKeys: Record<string, string>, packTgzB64: string): Promise<Record<string, string>> {
    const app = appNameFor(cfg.accountSlug);
    await this.ensureApp(app);
    const groups: Array<{ name: string; agents: AgentLaunchPlan[] }> =
      cfg.placement === "shared" ? [{ name: "fleet", agents: plans }] : plans.map((p) => ({ name: p.agentName, agents: [p] }));
    const ids: Record<string, string> = {};
    for (const g of groups) {
      const config = machineConfig({ image: this.image, perAgentMemoryMb: this.perAgentMemoryMb }, g.agents, agentKeys, packTgzB64);
      const r = await this.http("POST", `/apps/${app}/machines`, { name: g.name, region: this.region, config });
      const machine = r.json as { id?: string } | null;
      if (r.status < 200 || r.status >= 300 || !machine?.id) {
        throw new Error(`machine create ${app}/${g.name} failed (${r.status}): ${JSON.stringify(r.json).slice(0, 300)}`);
      }
      ids[g.name] = machine.id;
    }
    return ids;
  }

  async list(accountSlug: string): Promise<AgentMachine[]> {
    const r = await this.http("GET", `/apps/${appNameFor(accountSlug)}/machines`);
    if (r.status === 404) return []; // no app yet → no fleet
    if (r.status < 200 || r.status >= 300) throw new Error(`machine list failed (${r.status})`);
    return (r.json as Array<{ id: string; name: string; state: string }>).map((m) => ({ id: m.id, name: m.name, state: m.state }));
  }

  async start(accountSlug: string, machineId: string): Promise<void> {
    await this.lifecycle(accountSlug, machineId, "start");
  }
  async stop(accountSlug: string, machineId: string): Promise<void> {
    await this.lifecycle(accountSlug, machineId, "stop");
  }
  async restart(accountSlug: string, machineId: string): Promise<void> {
    await this.lifecycle(accountSlug, machineId, "restart");
  }
  private async lifecycle(accountSlug: string, machineId: string, verb: string): Promise<void> {
    const r = await this.http("POST", `/apps/${appNameFor(accountSlug)}/machines/${machineId}/${verb}`);
    if (r.status < 200 || r.status >= 300) throw new Error(`machine ${verb} failed (${r.status}): ${JSON.stringify(r.json).slice(0, 200)}`);
  }

  async destroyMachine(accountSlug: string, machineId: string): Promise<void> {
    const r = await this.http("DELETE", `/apps/${appNameFor(accountSlug)}/machines/${machineId}?force=true`);
    if (r.status < 200 || r.status >= 300) throw new Error(`machine destroy failed (${r.status})`);
  }

  /** Tear down the whole account fleet (app + all machines). */
  async destroyAccount(accountSlug: string): Promise<void> {
    const r = await this.http("DELETE", `/apps/${appNameFor(accountSlug)}`);
    if (r.status === 404) return; // already gone — idempotent
    if (r.status < 200 || r.status >= 300) throw new Error(`app destroy failed (${r.status})`);
  }

  /** Orphan sweep (the lesson the build-worker sweep taught: never inherit a "no
   *  sweeper" gap): list every vh-agents-* app in the org and return the slugs that
   *  are NOT in the platform's known-accounts set. The caller decides destroy vs
   *  alert — the sweep only OBSERVES, so a store outage can't cascade into mass
   *  teardown of healthy fleets. */
  async sweepOrphans(knownAccountSlugs: Set<string>): Promise<string[]> {
    const r = await this.http("GET", `/apps?org_slug=${encodeURIComponent(this.orgSlug)}`);
    if (r.status < 200 || r.status >= 300) throw new Error(`app list failed (${r.status})`);
    const apps = ((r.json as { apps?: Array<{ name: string }> })?.apps ?? []).map((a) => a.name);
    return apps
      .filter((n) => n.startsWith(APP_PREFIX))
      .map((n) => n.slice(APP_PREFIX.length))
      .filter((slug) => !knownAccountSlugs.has(slug));
  }
}
