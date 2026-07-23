import { describe, expect, test } from "bun:test";
import { AgentHostingService, encodePackFiles, mintAgentIdentity, priceEstimate, type AccountStore, type AgentAccountRecord, type AgentKeyVault } from "./service.ts";
import { AgentMachineManager, type FlyHttp } from "./machines.ts";
import type { AccountConfig } from "./types.ts";

function account(placement: "shared" | "isolated" = "shared"): AccountConfig {
  return {
    tenantId: "t1",
    accountSlug: "acme",
    ownerPubkey: "a".repeat(64),
    relayUrl: "wss://acme.communities.buzz.xyz",
    commsMode: "hub-and-spoke",
    placement,
    chiefOfStaff: "chief",
    agents: [
      { name: "chief", displayName: "Chief", description: "hub", personaPrompt: "You are Chief.", model: "anthropic:claude-sonnet-4-20250514", subscribe: ["#general"], skills: [], mcpServers: [] },
      { name: "scout", displayName: "Scout", description: "research", personaPrompt: "You are Scout.", model: "openai:gpt-5", subscribe: ["#research"], skills: [], mcpServers: [] },
    ],
  };
}

function memStore(): AccountStore & { data: Map<string, AgentAccountRecord> } {
  const data = new Map<string, AgentAccountRecord>();
  return {
    data,
    get: async (t) => data.get(t) ?? null,
    save: async (t, r) => void data.set(t, r),
  };
}
function memVault(): AgentKeyVault & { keys: Map<string, string> } {
  const keys = new Map<string, string>();
  return {
    keys,
    save: async (t, a, k) => void keys.set(`${t}/${a}`, k),
    load: async (t, a) => keys.get(`${t}/${a}`) ?? null,
  };
}
function fakeMachines() {
  const calls: string[] = [];
  let machineN = 0;
  const http: FlyHttp = async (method, path) => {
    calls.push(`${method} ${path}`);
    if (path.endsWith("/machines") && method === "POST") return { status: 200, json: { id: `m-${++machineN}` } };
    if (method === "GET" && path.includes("/machines")) return { status: 200, json: [{ id: "m-1", name: "fleet", state: "started" }] };
    return { status: 200, json: {} };
  };
  return { calls, machines: new AgentMachineManager({ http, orgSlug: "vibehard", image: "img" }) };
}

const service = (store = memStore(), vault = memVault(), fm = fakeMachines()) =>
  ({ svc: new AgentHostingService({ store, vault, machines: fm.machines, now: () => "2026-07-23T00:00:00Z" }), store, vault, fm });

describe("mintAgentIdentity — real BIP-340 x-only identities", () => {
  test("64-hex secret + 64-hex x-only pubkey, unique per mint", () => {
    const a = mintAgentIdentity();
    const b = mintAgentIdentity();
    expect(a.secretKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(a.pubkeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(a.secretKeyHex).not.toBe(b.secretKeyHex);
  });
});

describe("priceEstimate — the pass-through structure is the contract", () => {
  test("shared is strictly cheaper than isolated for N>1, equal at N=1", () => {
    expect(priceEstimate("shared", 1).monthlyCents).toBeLessThanOrEqual(priceEstimate("isolated", 1).monthlyCents);
    for (const n of [2, 3, 8]) {
      expect(priceEstimate("shared", n).monthlyCents).toBeLessThan(priceEstimate("isolated", n).monthlyCents);
    }
  });
});

describe("AgentHostingService — draft → provision → status → destroy", () => {
  test("saveDraft rejects an invalid config before any identity/Machine exists", async () => {
    const { svc } = service();
    const bad = account();
    bad.agents[0]!.model = "no-colon";
    const r = await svc.saveDraft(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(" ")).toContain("provider:model-id");
  });

  test("provision mints identities, vaults keys, creates the fleet, saves the record", async () => {
    const { svc, store, vault } = service();
    await svc.saveDraft(account());
    const rec = await svc.provision("t1");
    expect(rec.status).toBe("provisioned");
    expect(Object.keys(rec.agentPubkeys).sort()).toEqual(["chief", "scout"]);
    expect(rec.machineIds).toEqual({ fleet: "m-1" }); // shared placement → one Machine
    expect(vault.keys.size).toBe(2);
    expect(store.data.get("t1")!.provisionedAt).toBe("2026-07-23T00:00:00Z");
  });

  test("re-provision KEEPS existing identities (channel memberships reference pubkeys)", async () => {
    const { svc } = service();
    await svc.saveDraft(account());
    const first = await svc.provision("t1");
    const second = await svc.provision("t1");
    expect(second.agentPubkeys).toEqual(first.agentPubkeys);
  });

  test("status surfaces record + live machines + pricing together", async () => {
    const { svc } = service();
    await svc.saveDraft(account());
    await svc.provision("t1");
    const s = await svc.status("t1");
    expect(s!.machines).toEqual([{ id: "m-1", name: "fleet", state: "started" }]);
    expect(s!.pricing.placement).toBe("shared");
  });

  test("destroy tears down compute but keeps keys vaulted (identity survives)", async () => {
    const { svc, vault, store } = service();
    await svc.saveDraft(account());
    await svc.provision("t1");
    await svc.destroy("t1");
    expect(store.data.get("t1")!.status).toBe("destroyed");
    expect(store.data.get("t1")!.machineIds).toEqual({});
    expect(vault.keys.size).toBe(2); // NOT wiped
  });

  test("encodePackFiles round-trips through the entrypoint's decode shape", () => {
    const files = { ".plugin/plugin.json": "{}", "agents/a.persona.md": "---\n---\nhi" };
    const decoded = JSON.parse(Buffer.from(encodePackFiles(files), "base64").toString());
    expect(decoded).toEqual(files);
  });
});
