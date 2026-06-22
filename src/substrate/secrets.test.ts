import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEncryptedSecretsStore } from "./secrets.ts";

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "dd-secrets-"));
  tmps.push(d);
  return d;
}
const secret = { url: "https://x.supabase.co", anonKey: "anon-123", serviceKey: "service-XYZ-supersecret" };

describe("LocalEncryptedSecretsStore", () => {
  test("put → get round-trips the secrets", async () => {
    const s = new LocalEncryptedSecretsStore(await dir(), "pass-123");
    await s.put("app", secret);
    expect(await s.get("app")).toEqual(secret);
  });

  test("encrypted at rest — the plaintext keys are NOT in the file on disk", async () => {
    const s = new LocalEncryptedSecretsStore(await dir(), "pass");
    const ref = await s.put("app", secret);
    const raw = readFileSync(ref, "utf8");
    expect(raw).not.toContain("service-XYZ-supersecret");
    expect(raw).not.toContain("anon-123");
  });

  test("wrong passphrase → get returns null (auth fails); never a wrong plaintext", async () => {
    const d = await dir();
    await new LocalEncryptedSecretsStore(d, "right").put("app", secret);
    expect(await new LocalEncryptedSecretsStore(d, "wrong").get("app")).toBeNull();
  });

  test("tampered ciphertext → null (GCM auth tag catches it)", async () => {
    const d = await dir();
    const s = new LocalEncryptedSecretsStore(d, "p");
    const ref = await s.put("app", secret);
    const raw = Buffer.from(readFileSync(ref, "utf8"), "base64");
    raw.writeUInt8(raw.readUInt8(raw.length - 1) ^ 0xff, raw.length - 1); // flip a ciphertext byte
    writeFileSync(ref, raw.toString("base64"));
    expect(await s.get("app")).toBeNull();
  });

  test("missing → null; remove works; no passphrase → throws (fail closed)", async () => {
    const d = await dir();
    const s = new LocalEncryptedSecretsStore(d, "p");
    expect(await s.get("nope")).toBeNull();
    await s.put("app", secret);
    await s.remove("app");
    expect(await s.get("app")).toBeNull();
    expect(() => new LocalEncryptedSecretsStore(d, "")).toThrow(/passphrase/);
  });
});
