/**
 * DeploymentRecord persistence (docs/runtime-substrate § W4). v1 is a simple
 * file-backed store — one JSON file per app under a directory. The record is the
 * idempotency key + lifecycle backbone. `RecordStore` is async so a durable-DB
 * implementation (`PgRecordStore`, EPIC #33c) drops in behind the same interface;
 * this file-backed one just wraps synchronous fs calls in a resolved Promise.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentRecord, RecordStore } from "./types.ts";

const safe = (app: string): string => app.replace(/[^a-zA-Z0-9_-]/g, "_");

export class FileRecordStore implements RecordStore {
  constructor(private readonly dir: string) {}

  private path(app: string): string {
    return join(this.dir, `${safe(app)}.json`);
  }

  async get(app: string): Promise<DeploymentRecord | null> {
    const p = this.path(app);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as DeploymentRecord;
    } catch {
      return null;
    }
  }

  async put(record: DeploymentRecord): Promise<void> {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(record.app), JSON.stringify(record, null, 2));
  }

  async remove(app: string): Promise<void> {
    const p = this.path(app);
    if (existsSync(p)) rmSync(p, { force: true });
  }
}
