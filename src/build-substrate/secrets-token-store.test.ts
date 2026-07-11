import { afterEach, describe, expect, test } from "bun:test";
import { ensureSecretsTokenSchema, InMemorySecretsTokenStore, PgSecretsTokenStore, type SecretsTokenStore } from "./secrets-token-store.ts";
import { pgliteSql, type Sql } from "../platform/pg-store.ts";

// Same pglite-per-test discipline as build-log-store.test.ts: real Postgres engine, no Docker/network.
const dbs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
});
async function freshSql(): Promise<Sql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  dbs.push(db);
  const sql = pgliteSql(db);
  await ensureSecretsTokenSchema(sql);
  return sql;
}

/** Runs the SAME contract against both implementations — matching the discipline in
 *  build-log-store.test.ts and workspace-store.test.ts: a fake that doesn't behave like the
 *  real store is worthless for testing anything that depends on it. */
function contractTests(name: string, makeStore: () => Promise<SecretsTokenStore>): void {
  describe(`SecretsTokenStore contract — ${name}`, () => {
    test("mint then consume returns the exact bound env", async () => {
      const store = await makeStore();
      const token = await store.mint({ ANTHROPIC_API_KEY: "sk-ant-secret" });
      expect(await store.consume(token)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-secret" });
    });

    test("THE CONTRACT THIS CLOSES: a token is single-use — the second consume returns null, not the env again", async () => {
      const store = await makeStore();
      const token = await store.mint({ SECRET: "only-once" });
      const first = await store.consume(token);
      const second = await store.consume(token);
      expect(first).toEqual({ SECRET: "only-once" });
      expect(second).toBeNull();
    });

    test("an unknown token returns null", async () => {
      const store = await makeStore();
      expect(await store.consume("never-minted")).toBeNull();
    });

    test("an expired token returns null, even though it was never consumed", async () => {
      const store = await makeStore();
      const token = await store.mint({ SECRET: "x" }, -1); // already-expired ttl
      expect(await store.consume(token)).toBeNull();
    });

    test("two mints for the same env produce different, independently-consumable tokens", async () => {
      const store = await makeStore();
      const t1 = await store.mint({ SECRET: "a" });
      const t2 = await store.mint({ SECRET: "a" });
      expect(t1).not.toBe(t2);
      expect(await store.consume(t1)).toEqual({ SECRET: "a" });
      expect(await store.consume(t2)).toEqual({ SECRET: "a" }); // t1's consumption didn't affect t2
    });
  });
}

contractTests("InMemorySecretsTokenStore (fake)", async () => new InMemorySecretsTokenStore());
contractTests("PgSecretsTokenStore (real pglite)", async () => new PgSecretsTokenStore(await freshSql()));

describe("PgSecretsTokenStore — concurrent-consume race (SPEC decision #8's single-use guarantee under real contention)", () => {
  test("N concurrent consume() calls on the same token: exactly one wins", async () => {
    const store = new PgSecretsTokenStore(await freshSql());
    const token = await store.mint({ SECRET: "contested" });
    const results = await Promise.all(Array.from({ length: 8 }, () => store.consume(token)));
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual({ SECRET: "contested" });
  });
});
