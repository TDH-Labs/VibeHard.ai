import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTenantStore } from "./tenant-store.ts";
import type { Tenant } from "./types.ts";

const tenant = (id: string): Tenant => ({ id, name: `n-${id}`, plan: "free", status: "active", createdAt: "t" });

describe("FileTenantStore", () => {
  test("create + get round-trips; missing → null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-ten-"));
    try {
      const store = new FileTenantStore(dir);
      expect(await store.get("x")).toBeNull();
      await store.create(tenant("x"));
      expect(await store.get("x")).toEqual(tenant("x"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("create is idempotency-guarded (duplicate id throws); update requires existence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-ten-"));
    try {
      const store = new FileTenantStore(dir);
      await store.create(tenant("x"));
      await expect(store.create(tenant("x"))).rejects.toThrow(/already exists/);
      await expect(store.update(tenant("ghost"))).rejects.toThrow(/not found/);
      await store.update({ ...tenant("x"), plan: "pro" });
      expect((await store.get("x"))?.plan).toBe("pro");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("list returns all, skips corrupt files; missing dir → []", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-ten-"));
    try {
      const store = new FileTenantStore(dir);
      expect(await new FileTenantStore(join(dir, "nope")).list()).toEqual([]);
      await store.create(tenant("a"));
      await store.create(tenant("b"));
      writeFileSync(join(dir, "corrupt.json"), "{not json");
      writeFileSync(join(dir, "ignore.txt"), "skip me");
      expect((await store.list()).map((t) => t.id).sort()).toEqual(["a", "b"]); // corrupt + non-json skipped
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("id is sanitized into the filename (no path traversal)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-ten-"));
    try {
      const store = new FileTenantStore(dir);
      await store.create(tenant("../../evil"));
      // it lands inside dir under a sanitized name and round-trips by the same id
      expect((await store.get("../../evil"))?.id).toBe("../../evil");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
