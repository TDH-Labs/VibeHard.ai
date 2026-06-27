import { describe, expect, test } from "bun:test";
import { isSafeAppName } from "./safe-path.ts";

describe("isSafeAppName — refuses anything that could traverse out of a tenant workspace", () => {
  test("accepts the names the builder mints + reasonable slugs", () => {
    for (const ok of ["app-abc123", "app-1k2j3", "client-portal", "Invoice_Tracker", "a", "a.b-c_d"]) {
      expect(isSafeAppName(ok)).toBe(true);
    }
  });

  test("rejects path traversal and separators (the CRITICAL-1 payloads)", () => {
    for (const bad of [
      "../other-tenant/apps/x",
      "..",
      "../../../../etc/passwd",
      "app/../../escape",
      "a/b",
      "a\\b",
      "foo\0bar",
      ".hidden",
      "/abs",
      "",
      " ",
    ]) {
      expect(isSafeAppName(bad)).toBe(false);
    }
  });

  test("rejects non-strings and over-long names", () => {
    expect(isSafeAppName(undefined)).toBe(false);
    expect(isSafeAppName(null)).toBe(false);
    expect(isSafeAppName(123)).toBe(false);
    expect(isSafeAppName("a".repeat(65))).toBe(false);
  });
});
