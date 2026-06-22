/**
 * DeploymentRecord persistence (docs/runtime-substrate § W4). v1 is a simple
 * file-backed store — one JSON file per app under a directory. The record is the
 * idempotency key + lifecycle backbone; a platform DB drops in behind `RecordStore`
 * later. Synchronous on purpose: tiny files, called between async provider steps.
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

  get(app: string): DeploymentRecord | null {
    const p = this.path(app);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as DeploymentRecord;
    } catch {
      return null;
    }
  }

  put(record: DeploymentRecord): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(record.app), JSON.stringify(record, null, 2));
  }

  remove(app: string): void {
    const p = this.path(app);
    if (existsSync(p)) rmSync(p, { force: true });
  }
}
