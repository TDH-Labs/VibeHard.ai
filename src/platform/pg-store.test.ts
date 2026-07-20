import { afterEach, describe, expect, test } from "bun:test";
import { ensureEscalationSchema, ensurePlatformSchema, ensureSubstrateSchema, pgliteSql, PgEscalationSink, PgRecordStore, PgSecretsStore, PgTenantStore, type Sql } from "./pg-store.ts";
import type { Tenant } from "./types.ts";
import type { BackendSecrets, DeploymentRecord } from "../substrate/types.ts";
import { ticketId, type EscalationPacket } from "../escalation/index.ts";

// Each test gets a fresh embedded Postgres (pglite) — same engine as prod Postgres, no Docker/network.
const dbs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
});
async function freshSql(): Promise<Sql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  dbs.push(db);
  const sql = pgliteSql(db);
  await ensurePlatformSchema(sql);
  return sql;
}

const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  id: "t-1",
  name: "Acme",
  plan: "free",
  status: "active",
  createdAt: "2026-06-27T00:00:00.000Z",
  ...over,
});

describe("PgTenantStore — durable tenant persistence", () => {
  test("create → get round-trips every field", async () => {
    const store = new PgTenantStore(await freshSql());
    await store.create(tenant());
    expect(await store.get("t-1")).toEqual(tenant());
  });

  test("get(unknown) → null", async () => {
    const store = new PgTenantStore(await freshSql());
    expect(await store.get("nope")).toBeNull();
  });

  test("list returns all, ordered by createdAt", async () => {
    const store = new PgTenantStore(await freshSql());
    await store.create(tenant({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }));
    await store.create(tenant({ id: "b", createdAt: "2026-02-01T00:00:00.000Z" }));
    expect((await store.list()).map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("update changes plan/status; id + createdAt immutable", async () => {
    const store = new PgTenantStore(await freshSql());
    await store.create(tenant());
    await store.update(tenant({ plan: "pro", status: "suspended" }));
    const got = await store.get("t-1");
    expect(got).toMatchObject({ plan: "pro", status: "suspended", createdAt: "2026-06-27T00:00:00.000Z" });
  });

  test("create is idempotent (conflict do nothing) — no duplicate, no throw", async () => {
    const store = new PgTenantStore(await freshSql());
    await store.create(tenant());
    await store.create(tenant({ name: "ignored-second-write" }));
    expect((await store.list()).length).toBe(1);
    expect((await store.get("t-1"))?.name).toBe("Acme");
  });

  test("DURABILITY: a fresh store over the SAME db sees prior writes (survives a 'restart')", async () => {
    const sql = await freshSql();
    await new PgTenantStore(sql).create(tenant({ id: "persist", plan: "starter" }));
    // simulate a process restart: a brand-new store instance over the same database
    const reopened = new PgTenantStore(sql);
    expect((await reopened.get("persist"))?.plan).toBe("starter");
  });
});

const record = (over: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  app: "app-1",
  customerOrgRef: "org",
  projectRef: "ref",
  hostRef: "host",
  url: "https://app-1.fly.dev",
  appliedMigrations: ["0001", "0002"],
  secretsRef: "app-1",
  status: "live",
  updatedAt: "2026-06-27T00:00:00.000Z",
  ...over,
});

describe("PgRecordStore — durable deployment records, tenant-scoped", () => {
  async function store(scope = "tenant-A"): Promise<PgRecordStore> {
    const sql = await freshSql();
    await ensureSubstrateSchema(sql);
    return new PgRecordStore(sql, scope);
  }
  test("put → get round-trips the full record; remove deletes", async () => {
    const s = await store();
    await s.put(record());
    expect(await s.get("app-1")).toEqual(record());
    await s.remove("app-1");
    expect(await s.get("app-1")).toBeNull();
  });
  test("put upserts (second write wins)", async () => {
    const s = await store();
    await s.put(record());
    await s.put(record({ status: "destroyed" }));
    expect((await s.get("app-1"))?.status).toBe("destroyed");
  });
  test("scoped by tenant — same app id in two tenants doesn't collide", async () => {
    const sql = await freshSql();
    await ensureSubstrateSchema(sql);
    const a = new PgRecordStore(sql, "tenant-A");
    const b = new PgRecordStore(sql, "tenant-B");
    await a.put(record({ app: "shared", url: "https://a" }));
    await b.put(record({ app: "shared", url: "https://b" }));
    expect((await a.get("shared"))?.url).toBe("https://a");
    expect((await b.get("shared"))?.url).toBe("https://b");
  });
});

describe("PgSecretsStore — encrypted-at-rest in Postgres", () => {
  const secrets: BackendSecrets = { url: "https://x.supabase.co", anonKey: "anon", serviceKey: "service-role-SECRET", dbPassword: "pw" };
  async function store(pass = "passphrase-32-chars-minimum-xxxxx"): Promise<{ s: PgSecretsStore; sql: Sql }> {
    const sql = await freshSql();
    await ensureSubstrateSchema(sql);
    return { s: new PgSecretsStore(sql, pass, "tenant-A"), sql };
  }
  test("put → get round-trips secrets; stored value is ciphertext (not plaintext)", async () => {
    const { s, sql } = await store();
    await s.put("app-1", secrets);
    expect(await s.get("app-1")).toEqual(secrets);
    const raw = await sql(`select blob from app_secrets where scope = $1 and app = $2`, ["tenant-A", "app-1"]);
    expect(String(raw[0]!.blob)).not.toContain("service-role-SECRET"); // genuinely encrypted
  });
  test("wrong passphrase → null (no plaintext leak)", async () => {
    const { sql } = await store();
    await new PgSecretsStore(sql, "right-passphrase-................", "tenant-A").put("app-1", secrets);
    expect(await new PgSecretsStore(sql, "wrong-passphrase-................", "tenant-A").get("app-1")).toBeNull();
  });
  test("missing passphrase → constructor throws (fail-closed)", async () => {
    const { sql } = await store();
    expect(() => new PgSecretsStore(sql, "", "tenant-A")).toThrow(/passphrase/);
  });
});

// 2026-07-20: the durable equivalent of LocalEscalationSink — see its own class comment (the bug
// this closes: an E2B-dispatched build's ticket used to be lost the instant its sandbox tore down).
const packet = (over: Partial<EscalationPacket> = {}): EscalationPacket => ({
  workspacePath: "/home/user/workspace",
  createdAt: "2026-07-20T00:00:00.000Z",
  reason: "deploy blocked by the gate chain",
  items: [{ ref: "app/update-password/page.tsx:1:sast-1", finding: { tool: "sast", file: "app/update-password/page.tsx", line: 1, ruleId: "sast-1", severity: "high", message: "x" }, specialty: "security", slice: null }],
  specialties: ["security"],
  blocking: 1,
  ...over,
});

describe("PgEscalationSink — durable escalation queue, the third instance of the sandbox-durability defect", () => {
  async function store(scope = "tenant-A"): Promise<PgEscalationSink> {
    const sql = await freshSql();
    await ensureEscalationSchema(sql);
    return new PgEscalationSink(sql, scope);
  }

  test("open() → get() round-trips the ticket in needs-human state", async () => {
    const s = await store();
    const p = packet();
    const ticket = await s.open(p, "2026-07-20T00:00:00.000Z");
    expect(ticket.state).toBe("needs-human");
    expect(ticket.id).toBe(ticketId(p));
    expect(await s.get(ticket.id)).toEqual(ticket);
  });

  test("open() is idempotent — re-queuing the identical packet returns the SAME ticket, doesn't reset its state", async () => {
    const s = await store();
    const p = packet();
    const first = await s.open(p, "2026-07-20T00:00:00.000Z");
    await s.claim(first.id, "alice");
    const second = await s.open(p, "2026-07-20T01:00:00.000Z"); // re-queue after it was already claimed
    expect(second.state).toBe("claimed"); // NOT reset back to needs-human
    expect(second.claimedBy).toBe("alice");
  });

  test("claim() then resolve() carries the full needs-human → claimed → resolved lifecycle", async () => {
    const s = await store();
    const ticket = await s.open(packet());
    const claimed = await s.claim(ticket.id, "alice");
    expect(claimed.state).toBe("claimed");
    expect(claimed.claimedBy).toBe("alice");
    const resolved = await s.resolve(ticket.id, [
      { ref: ticket.packet.items[0]!.ref, verdict: "approved", reviewer: "alice", justification: "reviewed, safe", decidedAt: "2026-07-20T02:00:00.000Z" },
    ]);
    expect(resolved.state).toBe("resolved");
    expect(await s.get(ticket.id)).toEqual(resolved); // persisted, not just returned in-memory
  });

  test("get(unknown) → null", async () => {
    expect(await (await store()).get("esc-nope")).toBeNull();
  });

  test("list() returns all tickets for this tenant, optionally filtered by state", async () => {
    const s = await store();
    const a = await s.open(packet({ workspacePath: "/a" }));
    await s.open(packet({ workspacePath: "/b" }));
    await s.claim(a.id, "alice");
    expect((await s.list()).length).toBe(2);
    expect((await s.list("claimed")).map((t) => t.id)).toEqual([a.id]);
  });

  test("scoped by tenant — the SAME packet in two tenants gets two independent tickets", async () => {
    const sql = await freshSql();
    await ensureEscalationSchema(sql);
    const a = new PgEscalationSink(sql, "tenant-A");
    const b = new PgEscalationSink(sql, "tenant-B");
    const p = packet();
    await a.claim((await a.open(p)).id, "alice");
    const bTicket = await b.open(p);
    expect(bTicket.state).toBe("needs-human"); // tenant B's own ticket, unaffected by tenant A's claim
  });

  test("DURABILITY: a fresh sink over the SAME db sees a ticket opened by a DIFFERENT sink instance — this is the actual bug fixed (the sandbox's write and the platform's later read are different processes)", async () => {
    const sql = await freshSql();
    await ensureEscalationSchema(sql);
    const opened = await new PgEscalationSink(sql, "tenant-A").open(packet());
    const reread = await new PgEscalationSink(sql, "tenant-A").get(opened.id);
    expect(reread).toEqual(opened);
  });
});
