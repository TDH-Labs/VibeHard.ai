import { describe, expect, test } from "bun:test";
import { coerceChecks, summarize } from "./functest.ts";

describe("coerceChecks (trust boundary)", () => {
  test("parses valid checks, dedupes by feature, caps", () => {
    const out = coerceChecks({
      checks: [
        { feature: " Login ", status: "works", note: "auth wired" },
        { feature: "Login", status: "missing", note: "dup dropped" },
        { feature: "Save note", status: "partial", note: "no persistence" },
        { feature: "Search", status: "bogus", note: "invalid status → partial" },
        { feature: "", status: "works", note: "blank feature dropped" },
      ],
    });
    expect(out).toEqual([
      { feature: "Login", status: "works", note: "auth wired" },
      { feature: "Save note", status: "partial", note: "no persistence" },
      { feature: "Search", status: "partial", note: "invalid status → partial" },
    ]);
  });
  test("accepts a bare array; garbage → []", () => {
    expect(coerceChecks([{ feature: "X", status: "works", note: "" }])).toHaveLength(1);
    expect(coerceChecks("nope")).toEqual([]);
    expect(coerceChecks(null)).toEqual([]);
    expect(coerceChecks({ checks: "nope" })).toEqual([]);
  });
});

describe("summarize", () => {
  test("counts by status", () => {
    expect(
      summarize([
        { feature: "a", status: "works", note: "" },
        { feature: "b", status: "works", note: "" },
        { feature: "c", status: "partial", note: "" },
        { feature: "d", status: "missing", note: "" },
      ]),
    ).toEqual({ works: 2, partial: 1, missing: 1, total: 4 });
  });
});
