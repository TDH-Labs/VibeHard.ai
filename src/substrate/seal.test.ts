import { describe, expect, test } from "bun:test";
import { seal, unseal, sealJson, unsealJson } from "./seal.ts";

describe("seal / unseal — authenticated encryption at rest", () => {
  test("round-trips a string under the right passphrase", () => {
    const blob = seal("hello secret", "passphrase-123");
    expect(unseal(blob, "passphrase-123")).toBe("hello secret");
  });

  test("wrong passphrase → null (never wrong plaintext)", () => {
    const blob = seal("hello", "right");
    expect(unseal(blob, "wrong")).toBeNull();
  });

  test("tampered ciphertext → null (GCM auth fails)", () => {
    const blob = seal("hello", "k");
    const bytes = Buffer.from(blob, "base64");
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0xff; // flip a ciphertext bit
    expect(unseal(bytes.toString("base64"), "k")).toBeNull();
  });

  test("a distinct ciphertext each time (random salt+iv), same plaintext", () => {
    const a = seal("x", "k");
    const b = seal("x", "k");
    expect(a).not.toBe(b);
    expect(unseal(a, "k")).toBe("x");
    expect(unseal(b, "k")).toBe("x");
  });

  test("sealJson / unsealJson round-trip an object; garbage → null", () => {
    const obj = { a: 1, nested: { b: "two" } };
    expect(unsealJson<typeof obj>(sealJson(obj, "k"), "k")).toEqual(obj);
    expect(unsealJson("not-base64-or-valid", "k")).toBeNull();
  });
});
