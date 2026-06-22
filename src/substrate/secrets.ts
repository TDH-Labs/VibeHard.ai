/**
 * SecretsStore — encrypted-at-rest LOCAL store (docs/runtime-substrate § W3, v1). It
 * holds the app's connection secrets, INCLUDING the Supabase service-role key, so it
 * must be genuinely encrypted, not just "stored privately" — the NFR has teeth. v1 is
 * AES-256-GCM with a scrypt-derived key from a passphrase (env DRYDOCK_SECRETS_KEY); a
 * cloud KMS impl drops in behind the same seam later. Tamper or wrong key → GCM auth
 * fails → `get` returns null (never a silent wrong-plaintext).
 *
 * §16/§21: secrets are handled by reference where possible and NEVER logged.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { BackendSecrets, SecretsStore } from "./types.ts";

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const safe = (app: string): string => app.replace(/[^a-zA-Z0-9_-]/g, "_");

export class LocalEncryptedSecretsStore implements SecretsStore {
  readonly name = "local-encrypted";

  constructor(
    private readonly dir: string,
    private readonly passphrase: string,
  ) {
    if (!passphrase) {
      // Fail closed: refuse to operate without a key rather than store secrets weakly.
      throw new Error("LocalEncryptedSecretsStore needs a passphrase (set DRYDOCK_SECRETS_KEY)");
    }
  }

  private path(app: string): string {
    return join(this.dir, `${safe(app)}.enc`);
  }

  async put(app: string, secrets: BackendSecrets): Promise<string> {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const key = scryptSync(this.passphrase, salt, 32);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(secrets), "utf8")), cipher.final()]);
    const blob = Buffer.concat([salt, iv, cipher.getAuthTag(), ct]).toString("base64");
    const p = this.path(app);
    writeFileSync(p, blob);
    return p; // the secretsRef
  }

  async get(app: string): Promise<BackendSecrets | null> {
    const p = this.path(app);
    if (!existsSync(p)) return null;
    try {
      const blob = Buffer.from(readFileSync(p, "utf8"), "base64");
      const salt = blob.subarray(0, SALT_LEN);
      const iv = blob.subarray(SALT_LEN, SALT_LEN + IV_LEN);
      const tag = blob.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
      const ct = blob.subarray(SALT_LEN + IV_LEN + TAG_LEN);
      const key = scryptSync(this.passphrase, salt, 32);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return JSON.parse(pt.toString("utf8")) as BackendSecrets;
    } catch {
      // wrong passphrase or tampered ciphertext → auth tag check fails → null
      return null;
    }
  }

  async remove(app: string): Promise<void> {
    const p = this.path(app);
    if (existsSync(p)) rmSync(p, { force: true });
  }
}
