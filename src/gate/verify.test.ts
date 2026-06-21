import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { findEntry, summarizeVerify } from "./verify.ts";
import { verdictOf } from "../types.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures");

describe("summarizeVerify (pure)", () => {
  test("all runs healthy → no findings", () => {
    const runs = [
      { run: 1, status: 200 },
      { run: 2, status: 200 },
      { run: 3, status: 200 },
    ];
    expect(summarizeVerify(runs, 3)).toEqual([]);
  });

  test("any non-200 run → one blocking finding", () => {
    const runs = [
      { run: 1, status: 200 },
      { run: 2, status: 500 },
      { run: 3, status: 200 },
    ];
    const f = summarizeVerify(runs, 3);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ tool: "verify", ruleId: "health-check-failed", severity: "high" });
    expect(verdictOf("verify", f, "2026-06-20T00:00:00.000Z").status).toBe("block");
  });

  test("app never came up (status 0) → blocking", () => {
    const runs = [
      { run: 1, status: 0 },
      { run: 2, status: 0 },
      { run: 3, status: 0 },
    ];
    expect(summarizeVerify(runs, 3)).toHaveLength(1);
  });
});

describe("findEntry", () => {
  test("resolves package.json main for the fixtures", () => {
    expect(findEntry(join(FIXTURES, "remediated"))).toBe("server.js");
    expect(findEntry(join(FIXTURES, "vulnerable"))).toBe("server.js");
  });

  test("returns null when there is nothing to launch", () => {
    expect(findEntry(join(FIXTURES, "vulnerable", "supabase"))).toBeNull();
  });
});
