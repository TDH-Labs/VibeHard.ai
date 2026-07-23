import { describe, expect, test } from "bun:test";
import { AgentMachineManager, appNameFor, keyEnvVarFor, machineConfig, realFlyHttp, type FlyHttp, type FlyHttpResponse } from "./machines.ts";
import type { AccountConfig, AgentLaunchPlan } from "./types.ts";

const plan = (name: string): AgentLaunchPlan => ({
  agentName: name,
  privateKeyEnvVar: "BUZZ_PRIVATE_KEY",
  env: { BUZZ_RELAY_URL: "wss://acme.communities.buzz.xyz" },
  args: ["--respond-to", "owner-only"],
});
const KEYS = { chief: "k1", scout: "k2" };
const PACK = Buffer.from("fake-tgz").toString("base64");

function account(placement: "shared" | "isolated"): AccountConfig {
  return {
    tenantId: "t1",
    accountSlug: "acme",
    ownerPubkey: "a".repeat(64),
    relayUrl: "wss://acme.communities.buzz.xyz",
    commsMode: "hub-and-spoke",
    placement,
    chiefOfStaff: "chief",
    agents: [], // manager consumes plans, not agents — placement is what matters here
  };
}

/** Recording fake with scripted responses per "METHOD path-prefix". */
function fakeHttp(script: Record<string, FlyHttpResponse>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const http: FlyHttp = async (method, path, body) => {
    calls.push({ method, path, body });
    const hit = Object.entries(script).find(([k]) => `${method} ${path}`.startsWith(k));
    return hit ? hit[1] : { status: 200, json: {} };
  };
  return { calls, http };
}

const manager = (http: FlyHttp) => new AgentMachineManager({ http, orgSlug: "vibehard", image: "registry.fly.io/vh-agent-runtime:v1" });

describe("machineConfig — the env contract the entrypoint supervises", () => {
  test("carries AGENTS_JSON + pack + per-agent key vars; memory scales with agent count", () => {
    const cfg = machineConfig({ image: "img", perAgentMemoryMb: 768 }, [plan("chief"), plan("scout")], KEYS, PACK);
    const env = cfg.env as Record<string, string>;
    expect(JSON.parse(env.AGENTS_JSON!).map((a: { name: string }) => a.name)).toEqual(["chief", "scout"]);
    expect(env[keyEnvVarFor("chief")]).toBe("k1");
    expect(env[keyEnvVarFor("scout")]).toBe("k2");
    expect((cfg.guest as { memory_mb: number }).memory_mb).toBe(1536);
    expect((cfg.restart as { policy: string }).policy).toBe("always");
  });

  test("key env vars survive kebab-case agent names", () => {
    expect(keyEnvVarFor("data-scout")).toBe("AGENT_KEY_DATA_SCOUT");
  });

  test("missing key or oversized pack fails closed", () => {
    expect(() => machineConfig({ image: "i", perAgentMemoryMb: 768 }, [plan("ghost")], KEYS, PACK)).toThrow(/ghost/);
    expect(() => machineConfig({ image: "i", perAgentMemoryMb: 768 }, [plan("chief")], KEYS, "x".repeat(25 * 1024))).toThrow(/env budget/);
  });
});

describe("AgentMachineManager — provision/lifecycle/sweep against a scripted API", () => {
  test("shared placement → one app ensure + ONE fleet machine", async () => {
    const { calls, http } = fakeHttp({
      "POST /apps/vh-agents-acme/machines": { status: 200, json: { id: "m-1" } },
      "POST /apps": { status: 201, json: {} },
    });
    const ids = await manager(http).provision(account("shared"), [plan("chief"), plan("scout")], KEYS, PACK);
    expect(ids).toEqual({ fleet: "m-1" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/apps", body: { app_name: "vh-agents-acme", org_slug: "vibehard" } });
    expect(calls.filter((c) => c.path === "/apps/vh-agents-acme/machines")).toHaveLength(1);
  });

  test("isolated placement → one machine per agent; app-exists 422 is idempotent", async () => {
    let n = 0;
    const { calls, http } = fakeHttp({});
    const scripted: FlyHttp = async (m, p, b) => {
      if (p === "/apps" && m === "POST") return { status: 422, json: { error: "already exists" } };
      if (p.endsWith("/machines") && m === "POST") return { status: 200, json: { id: `m-${++n}` } };
      return http(m, p, b);
    };
    const ids = await manager(scripted).provision(account("isolated"), [plan("chief"), plan("scout")], KEYS, PACK);
    expect(ids).toEqual({ chief: "m-1", scout: "m-2" });
    expect(calls.length).toBe(0); // fully handled by the scripted responses
  });

  test("list: 404 (no app yet) → empty fleet, not an error", async () => {
    const { http } = fakeHttp({ "GET /apps/vh-agents-acme/machines": { status: 404, json: null } });
    expect(await manager(http).list("acme")).toEqual([]);
  });

  test("lifecycle verbs hit the documented endpoints and throw on failure", async () => {
    const { calls, http } = fakeHttp({ "POST /apps/vh-agents-acme/machines/m-1/stop": { status: 200, json: {} } });
    await manager(http).stop("acme", "m-1");
    expect(calls[0]!.path).toBe("/apps/vh-agents-acme/machines/m-1/stop");
    const failing = fakeHttp({ "POST /apps/vh-agents-acme/machines/m-1/start": { status: 500, json: { error: "boom" } } });
    await expect(manager(failing.http).start("acme", "m-1")).rejects.toThrow(/start failed \(500\)/);
  });

  test("sweepOrphans OBSERVES only: returns unknown vh-agents-* slugs, touches nothing", async () => {
    const { calls, http } = fakeHttp({
      "GET /apps": { status: 200, json: { apps: [{ name: "vh-agents-acme" }, { name: "vh-agents-ghost" }, { name: "vibehard-platform" }] } },
    });
    const orphans = await manager(http).sweepOrphans(new Set(["acme"]));
    expect(orphans).toEqual(["ghost"]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("destroyAccount: 404 is idempotent success", async () => {
    const { http } = fakeHttp({ "DELETE /apps/vh-agents-acme": { status: 404, json: null } });
    await manager(http).destroyAccount("acme"); // no throw
  });
});

// ── Live probe (read-only, free): verifies base URL + auth + response shape against
// the real Machines API using the platform's own app. Skipped without FLY_API_TOKEN.
const TOKEN = process.env.FLY_API_TOKEN;
describe.skipIf(!TOKEN)("Machines API live probe (read-only)", () => {
  test("GET /apps/vibehard-platform answers with the app record", async () => {
    const http = realFlyHttp(TOKEN!);
    const r = await http("GET", "/apps/vibehard-platform");
    expect(r.status).toBe(200);
    expect((r.json as { name: string }).name).toBe("vibehard-platform");
  }, 20_000);
});
