import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileUsageLedger } from "./usage.ts";
import type { UsageEvent } from "./types.ts";

const ev = (kind: UsageEvent["kind"], at: string, app?: string): UsageEvent => ({ kind, at, ...(app ? { app } : {}) });

describe("FileUsageLedger", () => {
  test("record appends; list reads back in order; missing tenant → []", () => {
    const base = mkdtempSync(join(tmpdir(), "dd-usage-"));
    try {
      const ledger = new FileUsageLedger(base);
      expect(ledger.list("t1")).toEqual([]);
      ledger.record("t1", ev("project_created", "2026-01-01T00:00:00Z", "a"));
      ledger.record("t1", ev("deploy", "2026-01-02T00:00:00Z", "a"));
      expect(ledger.list("t1").map((e) => e.kind)).toEqual(["project_created", "deploy"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("countSince filters by kind AND timestamp window", () => {
    const base = mkdtempSync(join(tmpdir(), "dd-usage-"));
    try {
      const ledger = new FileUsageLedger(base);
      ledger.record("t1", ev("build", "2026-06-01T00:00:00Z"));
      ledger.record("t1", ev("build", "2026-06-22T10:00:00Z"));
      ledger.record("t1", ev("build", "2026-06-22T11:00:00Z"));
      ledger.record("t1", ev("deploy", "2026-06-22T11:30:00Z"));
      // builds at/after the 22nd → 2 (the June-1 build is older; the deploy is a different kind)
      expect(ledger.countSince("t1", "build", "2026-06-22T00:00:00Z")).toBe(2);
      expect(ledger.countSince("t1", "deploy", "2026-06-22T00:00:00Z")).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a corrupt line is skipped, not fatal; tenants are isolated", () => {
    const base = mkdtempSync(join(tmpdir(), "dd-usage-"));
    try {
      const ledger = new FileUsageLedger(base);
      ledger.record("t1", ev("deploy", "2026-06-22T00:00:00Z", "a"));
      appendFileSync(join(base, "tenants", "t1", "usage.jsonl"), "{ not json\n");
      ledger.record("t1", ev("deploy", "2026-06-22T01:00:00Z", "b"));
      expect(ledger.list("t1").length).toBe(2); // corrupt middle line skipped
      expect(ledger.list("t2")).toEqual([]); // another tenant's ledger is separate
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
