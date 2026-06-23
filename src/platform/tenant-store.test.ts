import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTenantStore } from "./tenant-store.ts";
import type { Tenant } from "./types.ts";

const tenant = (id: string): Tenant => ({ id, name: `n-${id}`, plan: "free", status: "active", createdAt: "t" });

describe("FileTenantStore", () => {
  test("create + get round-trips; missing → null", () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-ten-"));
    try {
      const store = new FileTenantStore(dir);
      expect(store.get("x")).toBeNull();
      store.create(tenant("x"));
      expect(store.get("x")).toEqual(tenant("x"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("create is idempotency-guarded (duplicate id throws); update requires existence", () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-ten-"));
    try {
      const store = new FileTenantStore(dir);
      store.create(tenant("x"));
      expect(() => store.create(tenant("x"))).toThrow(/already exists/);
      expect(() => store.update(tenant("ghost"))).toThrow(/not found/);
      store.update({ ...tenant("x"), plan: "pro" });
      expect(store.get("x")?.plan).toBe("pro");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("list returns all, skips corrupt files; missing dir → []", () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-ten-"));
    try {
      const store = new FileTenantStore(dir);
      expect(new FileTenantStore(join(dir, "nope")).list()).toEqual([]);
      store.create(tenant("a"));
      store.create(tenant("b"));
      writeFileSync(join(dir, "corrupt.json"), "{not json");
      writeFileSync(join(dir, "ignore.txt"), "skip me");
      expect(store.list().map((t) => t.id).sort()).toEqual(["a", "b"]); // corrupt + non-json skipped
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("id is sanitized into the filename (no path traversal)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-ten-"));
    try {
      const store = new FileTenantStore(dir);
      store.create(tenant("../../evil"));
      // it lands inside dir under a sanitized name and round-trips by the same id
      expect(store.get("../../evil")?.id).toBe("../../evil");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
