/**
 * Authenticated encryption for secrets at rest (AES-256-GCM, scrypt-derived key). Extracted so the
 * file-backed and Postgres-backed secrets stores share ONE implementation — including the pinned
 * auth-tag length (the audit3 M-4 hardening). Blob layout: base64( salt | iv | tag | ciphertext ).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

/** Encrypt a UTF-8 string under `passphrase` → a base64 blob. */
export function seal(plain: string, passphrase: string): string {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), ct]).toString("base64");
}

/** Decrypt a blob from `seal`. Returns null on a wrong key / tampered / malformed input (fail-closed). */
export function unseal(blob: string, passphrase: string): string | null {
  try {
    const b = Buffer.from(blob, "base64");
    const salt = b.subarray(0, SALT_LEN);
    const iv = b.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag = b.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
    const ct = b.subarray(SALT_LEN + IV_LEN + TAG_LEN);
    if (tag.length !== TAG_LEN) return null; // truncated blob
    const key = scryptSync(passphrase, salt, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Seal a JSON-serializable value. */
export function sealJson(value: unknown, passphrase: string): string {
  return seal(JSON.stringify(value), passphrase);
}

/** Unseal to a JSON value, or null if it can't be decrypted/parsed. */
export function unsealJson<T>(blob: string, passphrase: string): T | null {
  const s = unseal(blob, passphrase);
  if (s === null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
