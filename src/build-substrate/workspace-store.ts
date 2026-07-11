/**
 * WorkspaceStore — the tenant build workspace's durable source of truth (docs/build-substrate/
 * {SPEC,PRD,ARCHITECTURE}.md, W1). Object storage (Tigris) instead of local disk: a build
 * worker pulls the whole tree into a local temp dir at start, works on local disk exactly as
 * today (nothing internal to `cli.ts build/fix` changes), and pushes a fresh tar at each
 * checkpoint. Whole-tree only in v1 — no incremental diffing (PRD R1, SPEC "Out of scope").
 *
 * Live-confirmed 2026-07-10 (docs/build-substrate/PRD.md spike item 1): a real E2B sandbox
 * can push/list/pull a realistic-size tar via presigned URLs with a byte-identical round-trip.
 * This implementation uses the S3 SDK directly (not presigned URLs) since it runs as the
 * dispatcher's own code, not inside the sandbox being provisioned.
 */
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Pull/push the tenant's workspace as a whole tree. `pull` always returns a directory —
 *  a tenant/app with no prior workspace (first-ever build) pulls to an EMPTY dir, not an
 *  error (PRD AC1.3). */
export interface WorkspaceStore {
  pull(tenantId: string, app: string): Promise<string>;
  push(tenantId: string, app: string, localDir: string): Promise<void>;
}

/** Time-limited PUT/GET URLs a BuildWorker's sandbox uses to pull/push the workspace directly
 *  (plain `curl`, no S3 SDK needed inside the sandbox) — the exact mechanism live-confirmed
 *  2026-07-10 (PRD spike item 1: byte-identical round-trip via presigned URLs from inside a
 *  real E2B sandbox). Provider-specific (presigning is an S3 concept), so this is its own
 *  interface rather than part of the generic `WorkspaceStore` contract. */
export interface PresignedWorkspaceUrls {
  pullUrl: string;
  pushUrl: string;
}

const TAR_TIMEOUT_MS = 120_000;

function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** One tar object per (tenant, app) — whole-tree overwrite on every push, no versioning in
 *  v1 (PRD R1 / SPEC "Out of scope": incremental sync is deferred). */
function objectKey(tenantId: string, app: string): string {
  return `workspaces/${safeSegment(tenantId)}/${safeSegment(app)}.tar`;
}

export class TigrisWorkspaceStore implements WorkspaceStore {
  private readonly s3: S3Client;

  constructor(
    private readonly bucket: string,
    s3?: S3Client,
  ) {
    this.s3 =
      s3 ??
      new S3Client({
        region: process.env.AWS_REGION || "auto",
        endpoint: process.env.AWS_ENDPOINT_URL_S3,
      });
  }

  async pull(tenantId: string, app: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "vibehard-workspace-"));
    const key = objectKey(tenantId, app);
    let body: Uint8Array;
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      body = await res.Body!.transformToByteArray();
    } catch (e) {
      const name = (e as { name?: string })?.name;
      const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (name === "NoSuchKey" || status === 404) return dir; // first-ever build for this app
      throw e;
    }
    const tmpTarDir = mkdtempSync(join(tmpdir(), "vibehard-workspace-tar-"));
    const tarPath = join(tmpTarDir, "pull.tar");
    try {
      await Bun.write(tarPath, body);
      const extract = Bun.spawnSync(["tar", "-xf", tarPath, "-C", dir], {
        timeout: TAR_TIMEOUT_MS,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((extract.exitCode ?? 1) !== 0) {
        const log = `${extract.stdout?.toString() ?? ""}${extract.stderr?.toString() ?? ""}`;
        throw new Error(`workspace pull: tar extract failed (exit ${extract.exitCode}): ${log.slice(-500)}`);
      }
    } finally {
      rmSync(tmpTarDir, { recursive: true, force: true });
    }
    return dir;
  }

  async push(tenantId: string, app: string, localDir: string): Promise<void> {
    const key = objectKey(tenantId, app);
    const tmpTarDir = mkdtempSync(join(tmpdir(), "vibehard-workspace-tar-"));
    const tarPath = join(tmpTarDir, "push.tar");
    try {
      const create = Bun.spawnSync(["tar", "-cf", tarPath, "-C", localDir, "."], {
        timeout: TAR_TIMEOUT_MS,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((create.exitCode ?? 1) !== 0) {
        const log = `${create.stdout?.toString() ?? ""}${create.stderr?.toString() ?? ""}`;
        throw new Error(`workspace push: tar create failed (exit ${create.exitCode}): ${log.slice(-500)}`);
      }
      const body = new Uint8Array(await Bun.file(tarPath).arrayBuffer());
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }));
    } finally {
      rmSync(tmpTarDir, { recursive: true, force: true });
    }
  }

  /** PUT/GET URLs for `curl`-based pull/push from inside a sandbox, valid for `expiresInSec`
   *  (default 1h — generous for a build that can run 45+ minutes; a checkpoint mid-build
   *  should never hit an expired URL). A GET on the pull URL 404s if there's no prior
   *  workspace (first-ever build) — the caller's script must tolerate that, same as `pull()`
   *  itself tolerates a missing object. */
  async presign(tenantId: string, app: string, expiresInSec = 3600): Promise<PresignedWorkspaceUrls> {
    const key = objectKey(tenantId, app);
    const [pullUrl, pushUrl] = await Promise.all([
      getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSec }),
      getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSec }),
    ]);
    return { pullUrl, pushUrl };
  }
}

/** In-memory fake — same real tar create/extract mechanics (that logic needs testing too),
 *  just the remote object storage swapped for a Map. No real network calls, matching the
 *  fake-provider-tested discipline `src/substrate/`'s seams already use. */
export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async pull(tenantId: string, app: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "vibehard-workspace-fake-"));
    const blob = this.blobs.get(objectKey(tenantId, app));
    if (!blob) return dir;
    const tmpTarDir = mkdtempSync(join(tmpdir(), "vibehard-workspace-fake-tar-"));
    const tarPath = join(tmpTarDir, "pull.tar");
    try {
      await Bun.write(tarPath, blob);
      const extract = Bun.spawnSync(["tar", "-xf", tarPath, "-C", dir], { timeout: TAR_TIMEOUT_MS, stdout: "pipe", stderr: "pipe" });
      if ((extract.exitCode ?? 1) !== 0) {
        throw new Error(`fake workspace pull: tar extract failed (exit ${extract.exitCode})`);
      }
    } finally {
      rmSync(tmpTarDir, { recursive: true, force: true });
    }
    return dir;
  }

  async push(tenantId: string, app: string, localDir: string): Promise<void> {
    const tmpTarDir = mkdtempSync(join(tmpdir(), "vibehard-workspace-fake-tar-"));
    const tarPath = join(tmpTarDir, "push.tar");
    try {
      const create = Bun.spawnSync(["tar", "-cf", tarPath, "-C", localDir, "."], { timeout: TAR_TIMEOUT_MS, stdout: "pipe", stderr: "pipe" });
      if ((create.exitCode ?? 1) !== 0) {
        throw new Error(`fake workspace push: tar create failed (exit ${create.exitCode})`);
      }
      this.blobs.set(objectKey(tenantId, app), new Uint8Array(await Bun.file(tarPath).arrayBuffer()));
    } finally {
      rmSync(tmpTarDir, { recursive: true, force: true });
    }
  }
}
