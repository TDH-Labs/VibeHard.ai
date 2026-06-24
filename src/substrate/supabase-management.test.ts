import { describe, expect, test } from "bun:test";
import { generateDbPassword, readManagementToken, SupabaseManagementClient } from "./supabase-management.ts";

type Handler = (method: string, path: string, body: unknown) => { status?: number; json?: unknown; text?: string };

/** A fake fetch that routes on `${method} ${path}` via the handler, recording calls. */
function fakeFetch(handler: Handler) {
  const calls: Array<{ method: string; path: string; body: unknown; auth?: string }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.supabase.com", "");
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ method, path, body, auth });
    const r = handler(method, path, body);
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => text } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noSleep = async (): Promise<void> => {};

describe("SupabaseManagementClient", () => {
  test("constructor requires a token", () => {
    expect(() => new SupabaseManagementClient({ token: "" })).toThrow(/SUPABASE_ACCESS_TOKEN/);
  });

  test("provisionProject: create → poll until healthy → keys → pooler host, assembled", async () => {
    let polls = 0;
    const { impl, calls } = fakeFetch((method, path) => {
      if (method === "GET" && path === "/v1/organizations") return { json: [{ id: "org_sole", name: "VibeHard" }] };
      if (method === "POST" && path === "/v1/projects") return { json: { id: "newref123", region: "us-east-1", status: "COMING_UP" } };
      if (method === "GET" && path === "/v1/projects/newref123") {
        polls++;
        return { json: { id: "newref123", status: polls >= 3 ? "ACTIVE_HEALTHY" : "COMING_UP" } };
      }
      if (path === "/v1/projects/newref123/api-keys")
        return { json: [{ name: "anon", api_key: "anon_k" }, { name: "service_role", api_key: "svc_k" }] };
      if (path === "/v1/projects/newref123/config/database/pooler")
        return { json: [{ db_host: "aws-1-us-east-1.pooler.supabase.com", db_user: "postgres.newref123" }] };
      return { status: 404, text: "unhandled" };
    });

    const client = new SupabaseManagementClient({ token: "sbp_x", fetchImpl: impl, sleep: noSleep });
    const p = await client.provisionProject({ name: "my-app" }, { delayMs: 1 });

    expect(p.ref).toBe("newref123");
    expect(p.url).toBe("https://newref123.supabase.co");
    expect(p.anonKey).toBe("anon_k");
    expect(p.serviceKey).toBe("svc_k");
    expect(p.dbHost).toBe("aws-1-us-east-1.pooler.supabase.com");
    expect(p.dbUser).toBe("postgres.newref123");
    expect(p.dbPassword.length).toBeGreaterThan(20); // generated
    expect(polls).toBe(3); // polled until healthy
    // org auto-discovered (sole), and the create body carried it + the generated password
    const create = calls.find((c) => c.method === "POST" && c.path === "/v1/projects");
    expect((create?.body as { organization_id: string }).organization_id).toBe("org_sole");
    expect((create?.body as { db_pass: string }).db_pass).toBe(p.dbPassword);
    // token rides in the header, never the body/path
    expect(calls.every((c) => c.auth === "Bearer sbp_x")).toBe(true);
  });

  test("resolveOrgId: explicit preferred wins without a network call", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 500, text: "should not be called" }));
    const client = new SupabaseManagementClient({ token: "t", fetchImpl: impl });
    expect(await client.resolveOrgId("org_explicit")).toBe("org_explicit");
    expect(calls.length).toBe(0);
  });

  test("resolveOrgId: ambiguous (>1 org) → throws asking for SUPABASE_ORG_ID", async () => {
    const { impl } = fakeFetch(() => ({ json: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }));
    const client = new SupabaseManagementClient({ token: "t", fetchImpl: impl });
    await expect(client.resolveOrgId()).rejects.toThrow(/multiple Supabase orgs/);
  });

  test("getApiKeys: missing service_role → throws", async () => {
    const { impl } = fakeFetch(() => ({ json: [{ name: "anon", api_key: "a" }] }));
    const client = new SupabaseManagementClient({ token: "t", fetchImpl: impl });
    await expect(client.getApiKeys("r")).rejects.toThrow(/missing anon\/service_role/);
  });

  test("waitHealthy: never healthy → throws after the bounded polls", async () => {
    const { impl } = fakeFetch(() => ({ json: { status: "COMING_UP" } }));
    const client = new SupabaseManagementClient({ token: "t", fetchImpl: impl, sleep: noSleep });
    await expect(client.waitHealthy("r", { tries: 3, delayMs: 1 })).rejects.toThrow(/ACTIVE_HEALTHY/);
  });

  test("provisionProject DELETES the orphan when a post-create step fails (no leaked billable project)", async () => {
    const deleted: string[] = [];
    const { impl } = fakeFetch((method, path) => {
      if (method === "GET" && path === "/v1/organizations") return { json: [{ id: "org", name: "O" }] };
      if (method === "POST" && path === "/v1/projects") return { json: { id: "leakref", status: "COMING_UP" } };
      if (method === "GET" && path === "/v1/projects/leakref") return { json: { status: "COMING_UP" } }; // never healthy → fails
      if (method === "DELETE" && path === "/v1/projects/leakref") {
        deleted.push("leakref");
        return { status: 200, text: "" };
      }
      return { status: 404, text: "unhandled" };
    });
    const client = new SupabaseManagementClient({ token: "t", fetchImpl: impl, sleep: noSleep });
    await expect(client.provisionProject({ name: "app" }, { tries: 2, delayMs: 1 })).rejects.toThrow(/deleted the orphaned project leakref/);
    expect(deleted).toEqual(["leakref"]); // the half-provisioned project was cleaned up, not leaked
  });

  test("a non-2xx API response surfaces status + body", async () => {
    const { impl } = fakeFetch(() => ({ status: 402, text: "payment required" }));
    const client = new SupabaseManagementClient({ token: "t", fetchImpl: impl });
    await expect(client.listOrganizations()).rejects.toThrow(/402: payment required/);
  });

  test("generateDbPassword: strong + URL-safe (no chars that break a connection URL)", () => {
    const pw = generateDbPassword();
    expect(pw.length).toBeGreaterThan(20);
    expect(pw).not.toMatch(/[@:/?#[\]+=]/);
    expect(generateDbPassword()).not.toBe(pw); // fresh each call
  });

  test("readManagementToken: prefers SUPABASE_ACCESS_TOKEN, falls back to SUPABASE_PAT", () => {
    const prevA = process.env.SUPABASE_ACCESS_TOKEN;
    const prevP = process.env.SUPABASE_PAT;
    try {
      delete process.env.SUPABASE_ACCESS_TOKEN;
      process.env.SUPABASE_PAT = "sbp_alias";
      expect(readManagementToken()).toBe("sbp_alias");
      process.env.SUPABASE_ACCESS_TOKEN = "sbp_canonical";
      expect(readManagementToken()).toBe("sbp_canonical");
    } finally {
      if (prevA === undefined) delete process.env.SUPABASE_ACCESS_TOKEN;
      else process.env.SUPABASE_ACCESS_TOKEN = prevA;
      if (prevP === undefined) delete process.env.SUPABASE_PAT;
      else process.env.SUPABASE_PAT = prevP;
    }
  });
});
