import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRecordStore } from "./record.ts";
import type { DeploymentRecord } from "./types.ts";

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "dd-record-"));
  tmps.push(d);
  return d;
}
const rec: DeploymentRecord = {
  app: "my app/1", // exercises path sanitization
  customerOrgRef: "org-1",
  projectRef: "proj-1",
  hostRef: "host-1",
  url: "https://app.example.com",
  appliedMigrations: ["0001", "0002"],
  secretsRef: "ref-1",
  status: "live",
  updatedAt: "2026-06-22T00:00:00.000Z",
};

describe("FileRecordStore", () => {
  test("put → get round-trips, and persists across a fresh store instance", async () => {
    const d = await dir();
    new FileRecordStore(d).put(rec);
    expect(new FileRecordStore(d).get("my app/1")).toEqual(rec); // a new instance reads it off disk
  });

  test("missing → null; remove deletes it", async () => {
    const d = await dir();
    const s = new FileRecordStore(d);
    expect(s.get("nope")).toBeNull();
    s.put(rec);
    s.remove("my app/1");
    expect(s.get("my app/1")).toBeNull();
  });
});
