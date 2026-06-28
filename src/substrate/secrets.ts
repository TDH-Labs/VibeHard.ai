/**
 * SecretsStore — encrypted-at-rest LOCAL store (docs/runtime-substrate § W3, v1). It
 * holds the app's connection secrets, INCLUDING the Supabase service-role key, so it
 * must be genuinely encrypted, not just "stored privately" — the NFR has teeth. v1 is
 * AES-256-GCM with a scrypt-derived key from a passphrase (env VIBEHARD_SECRETS_KEY); a
 * cloud KMS impl drops in behind the same seam later. Tamper or wrong key → GCM auth
 * fails → `get` returns null (never a silent wrong-plaintext).
 *
 * §16/§21: secrets are handled by reference where possible and NEVER logged.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sealJson, unsealJson } from "./seal.ts";
import type { BackendSecrets, SecretsStore } from "./types.ts";

const safe = (app: string): string => app.replace(/[^a-zA-Z0-9_-]/g, "_");

export class LocalEncryptedSecretsStore implements SecretsStore {
  readonly name = "local-encrypted";

  constructor(
    private readonly dir: string,
    private readonly passphrase: string,
  ) {
    if (!passphrase) {
      // Fail closed: refuse to operate without a key rather than store secrets weakly.
      throw new Error("LocalEncryptedSecretsStore needs a passphrase (set VIBEHARD_SECRETS_KEY)");
    }
  }

  private path(app: string): string {
    return join(this.dir, `${safe(app)}.enc`);
  }

  async put(app: string, secrets: BackendSecrets): Promise<string> {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const p = this.path(app);
    writeFileSync(p, sealJson(secrets, this.passphrase)); // AES-256-GCM via the shared seal helper
    return p; // the secretsRef
  }

  async get(app: string): Promise<BackendSecrets | null> {
    const p = this.path(app);
    if (!existsSync(p)) return null;
    try {
      return unsealJson<BackendSecrets>(readFileSync(p, "utf8"), this.passphrase); // null on wrong key/tamper
    } catch {
      // unreadable file → null
      return null;
    }
  }

  async remove(app: string): Promise<void> {
    const p = this.path(app);
    if (existsSync(p)) rmSync(p, { force: true });
  }
}
