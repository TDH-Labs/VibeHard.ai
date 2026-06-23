import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayAgo, FileBuildStore, type BuildJob } from "./build.ts";

const job = (id: string, tenantId: string): BuildJob => ({ id, tenantId, app: "a", status: "queued", queuedAt: "t" });

describe("FileBuildStore", () => {
  test("put + get round-trips; missing → null; isolated per tenant", () => {
    const base = mkdtempSync(join(tmpdir(), "dd-build-"));
    try {
      const store = new FileBuildStore(base);
      expect(store.get("t1", "j1")).toBeNull();
      store.put(job("j1", "t1"));
      expect(store.get("t1", "j1")?.id).toBe("j1");
      expect(store.get("t2", "j1")).toBeNull(); // another tenant can't see it
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("list returns a tenant's jobs only; missing dir → []", () => {
    const base = mkdtempSync(join(tmpdir(), "dd-build-"));
    try {
      const store = new FileBuildStore(base);
      expect(store.list("t1")).toEqual([]);
      store.put(job("j1", "t1"));
      store.put(job("j2", "t1"));
      store.put(job("j3", "t2"));
      expect(store.list("t1").map((j) => j.id).sort()).toEqual(["j1", "j2"]);
      expect(store.list("t2").map((j) => j.id)).toEqual(["j3"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("dayAgo", () => {
  test("is exactly 24h before the given ISO instant", () => {
    expect(dayAgo("2026-06-22T12:00:00.000Z")).toBe("2026-06-21T12:00:00.000Z");
  });
});
