/**
 * AgentHostingService (AHP-5) — the account-level orchestration the portal calls:
 * validate config → mint Nostr identities → persist keys (encrypted vault seam) →
 * generate the persona pack → compute launch plans → provision Fly Machines → durable
 * account record. Every dependency is a seam (store, vault, machines, clock) so the
 * whole flow unit-tests with fakes; the web layer wires real impls.
 *
 * NOTE ON THE WEB LAYER: the customer portal (web/server.ts — auth, Stripe, tenant KV)
 * lives on the in-flight fix/build-correctness-and-diagnose branch, NOT on main, so
 * this branch deliberately stops at the service seam. The HTTP wiring (five thin
 * endpoints + a wizard page) lands when the branches meet — docs/agent-hosting/
 * CONTRACTS.md records this. Integration with main's OWN platform layer (Platform
 * stateDir, plans) is real, not stubbed.
 */
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/secp256k1";
import type { AccountConfig, FileMap } from "./types.ts";
import { computeLaunchPlans, generatePersonaPack, validateAccountConfig } from "./persona-pack.ts";
import type { AgentMachineManager } from "./machines.ts";

/** Durable per-account state (NOT the keys — those live in the vault). */
export interface AgentAccountRecord {
  config: AccountConfig;
  agentPubkeys: Record<string, string>;
  machineIds: Record<string, string>; // group name ("fleet" or agent name) → machine id
  status: "draft" | "provisioned" | "destroyed";
  provisionedAt: string | null;
}

export interface AccountStore {
  get(tenantId: string): Promise<AgentAccountRecord | null>;
  save(tenantId: string, record: AgentAccountRecord): Promise<void>;
}

/** Encrypted-at-rest custody for agent secret keys (the vault is the ONLY place a
 *  secret key persists; Machines receive it at provision time, CONTRACTS.md posture). */
export interface AgentKeyVault {
  save(tenantId: string, agentName: string, secretKeyHex: string): Promise<void>;
  load(tenantId: string, agentName: string): Promise<string | null>;
}

/** Mint a Nostr identity: 32 random bytes → BIP-340 x-only pubkey (64-hex), the same
 *  shape `buzz-admin generate-key` produces (verified live 2026-07-23). */
export function mintAgentIdentity(rng: (n: number) => Uint8Array = (n) => randomBytes(n)): { secretKeyHex: string; pubkeyHex: string } {
  const sk = rng(32);
  const pk = schnorr.getPublicKey(sk);
  return { secretKeyHex: Buffer.from(sk).toString("hex"), pubkeyHex: Buffer.from(pk).toString("hex") };
}

/** Pack files → the machine-env payload (base64 JSON — replaced the earlier tarball
 *  idea: same size class, zero tar dependency, and the entrypoint just writes files). */
export function encodePackFiles(files: FileMap): string {
  return Buffer.from(JSON.stringify(files)).toString("base64");
}

// ── Pricing (the honest pass-through lever) ──────────────────────────────────────
// STRUCTURE is the contract: shared = one Machine sized per agent; isolated = one
// Machine per agent; the delta passes through directly. The cent CONSTANTS are ops
// config (env-overridable) and MUST be reconciled against fly.io/pricing before
// launch — they are deliberately conservative placeholders, not quotes.
const cents = (envKey: string, fallback: number): number => {
  const v = Number(process.env[envKey]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export interface PriceEstimate {
  placement: "shared" | "isolated";
  agentCount: number;
  monthlyCents: number;
  perAgentCents: number;
}

export function priceEstimate(placement: "shared" | "isolated", agentCount: number): PriceEstimate {
  const machineBase = cents("VIBEHARD_AGENT_MACHINE_BASE_CENTS", 500); // shared-cpu-1x + 512MB class
  const perAgentMem = cents("VIBEHARD_AGENT_MEMORY_CENTS", 300); // +768MB per additional agent process
  const monthlyCents =
    placement === "shared"
      ? machineBase + perAgentMem * Math.max(0, agentCount - 1) // one Machine, memory grows per agent
      : (machineBase + perAgentMem) * agentCount; // N full Machines
  return { placement, agentCount, monthlyCents, perAgentCents: agentCount ? Math.round(monthlyCents / agentCount) : 0 };
}

// ── The service ──────────────────────────────────────────────────────────────────

export interface AgentHostingServiceOptions {
  store: AccountStore;
  vault: AgentKeyVault;
  machines: AgentMachineManager;
  now?: () => string;
  mintIdentity?: () => { secretKeyHex: string; pubkeyHex: string };
}

export class AgentHostingService {
  private readonly store: AccountStore;
  private readonly vault: AgentKeyVault;
  private readonly machines: AgentMachineManager;
  private readonly now: () => string;
  private readonly mint: () => { secretKeyHex: string; pubkeyHex: string };

  constructor(opts: AgentHostingServiceOptions) {
    this.store = opts.store;
    this.vault = opts.vault;
    this.machines = opts.machines;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.mint = opts.mintIdentity ?? mintAgentIdentity;
  }

  /** Save/replace the account's draft config. Fail-closed: an invalid config is
   *  REJECTED here, before any identity or Machine exists. */
  async saveDraft(cfg: AccountConfig): Promise<{ ok: true } | { ok: false; problems: string[] }> {
    const problems = validateAccountConfig(cfg);
    if (problems.length) return { ok: false, problems };
    const existing = await this.store.get(cfg.tenantId);
    await this.store.save(cfg.tenantId, {
      config: cfg,
      agentPubkeys: existing?.agentPubkeys ?? {},
      machineIds: existing?.machineIds ?? {},
      status: existing?.status === "provisioned" ? "provisioned" : "draft",
      provisionedAt: existing?.provisionedAt ?? null,
    });
    return { ok: true };
  }

  /** Provision (or re-provision) the fleet. Idempotent on identities: an agent that
   *  already has a key keeps it (a re-provision must never rotate identities out from
   *  under channel memberships). */
  async provision(tenantId: string): Promise<AgentAccountRecord> {
    const rec = await this.store.get(tenantId);
    if (!rec) throw new Error("no account config saved for this tenant");
    const cfg = rec.config;
    const problems = validateAccountConfig(cfg);
    if (problems.length) throw new Error(`config invalid:\n- ${problems.join("\n- ")}`);

    const pubkeys: Record<string, string> = { ...rec.agentPubkeys };
    const keys: Record<string, string> = {};
    for (const a of cfg.agents) {
      const existing = await this.vault.load(tenantId, a.name);
      if (existing && pubkeys[a.name]) {
        keys[a.name] = existing;
        continue;
      }
      const id = this.mint();
      await this.vault.save(tenantId, a.name, id.secretKeyHex);
      keys[a.name] = id.secretKeyHex;
      pubkeys[a.name] = id.pubkeyHex;
    }

    const pack = generatePersonaPack(cfg);
    const plans = computeLaunchPlans(cfg, pubkeys);
    const machineIds = await this.machines.provision(cfg, plans, keys, encodePackFiles(pack));

    const next: AgentAccountRecord = { config: cfg, agentPubkeys: pubkeys, machineIds, status: "provisioned", provisionedAt: this.now() };
    await this.store.save(tenantId, next);
    return next;
  }

  /** Command-center status: durable record + live Machine states side by side. */
  async status(tenantId: string) {
    const rec = await this.store.get(tenantId);
    if (!rec) return null;
    const machines = rec.status === "provisioned" ? await this.machines.list(rec.config.accountSlug) : [];
    return { record: rec, machines, pricing: priceEstimate(rec.config.placement, rec.config.agents.length) };
  }

  async stopMachine(tenantId: string, machineId: string): Promise<void> {
    await this.machines.stop(await this.slugOf(tenantId), machineId);
  }
  async startMachine(tenantId: string, machineId: string): Promise<void> {
    await this.machines.start(await this.slugOf(tenantId), machineId);
  }
  async restartMachine(tenantId: string, machineId: string): Promise<void> {
    await this.machines.restart(await this.slugOf(tenantId), machineId);
  }

  /** Destroy the fleet (keys stay vaulted — identities survive for a future
   *  re-provision; destroying an account's compute must not orphan its Nostr
   *  identity, which channel memberships reference). */
  async destroy(tenantId: string): Promise<void> {
    const rec = await this.store.get(tenantId);
    if (!rec) return;
    await this.machines.destroyAccount(rec.config.accountSlug);
    await this.store.save(tenantId, { ...rec, machineIds: {}, status: "destroyed" });
  }

  private async slugOf(tenantId: string): Promise<string> {
    const rec = await this.store.get(tenantId);
    if (!rec) throw new Error("no account for tenant");
    return rec.config.accountSlug;
  }
}
