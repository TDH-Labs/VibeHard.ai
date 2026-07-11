import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkspaceStore, TigrisWorkspaceStore } from "./workspace-store.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-ws-test-"));
  tmps.push(d);
  return d;
}

describe("InMemoryWorkspaceStore (fake — no network)", () => {
  test("pull with no prior push returns an empty dir, not an error (AC1.3)", async () => {
    const store = new InMemoryWorkspaceStore();
    const dir = await store.pull("tenant-a", "app-1");
    tmps.push(dir);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test("push then pull round-trips the full tree, byte-identical content (AC1.1)", async () => {
    const store = new InMemoryWorkspaceStore();
    const src = scratch();
    mkdirSync(join(src, "app", "nested"), { recursive: true });
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(src, "app", "nested", "deep.ts"), "export const x = 1;\n");

    await store.push("tenant-b", "app-2", src);
    const pulled = await store.pull("tenant-b", "app-2");
    tmps.push(pulled);

    expect(readFileSync(join(pulled, "package.json"), "utf8")).toBe(JSON.stringify({ name: "x" }));
    expect(readFileSync(join(pulled, "app", "nested", "deep.ts"), "utf8")).toBe("export const x = 1;\n");
  });

  test("a second push overwrites the first (whole-tree, no versioning — v1 scope)", async () => {
    const store = new InMemoryWorkspaceStore();
    const src1 = scratch();
    writeFileSync(join(src1, "v.txt"), "v1");
    await store.push("tenant-c", "app-3", src1);

    const src2 = scratch();
    writeFileSync(join(src2, "v.txt"), "v2");
    await store.push("tenant-c", "app-3", src2);

    const pulled = await store.pull("tenant-c", "app-3");
    tmps.push(pulled);
    expect(readFileSync(join(pulled, "v.txt"), "utf8")).toBe("v2");
  });

  test("different (tenant, app) pairs are isolated from each other", async () => {
    const store = new InMemoryWorkspaceStore();
    const srcA = scratch();
    writeFileSync(join(srcA, "who.txt"), "tenant-x");
    await store.push("tenant-x", "shared-app-name", srcA);

    const pulledForY = await store.pull("tenant-y", "shared-app-name");
    tmps.push(pulledForY);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(pulledForY)).toHaveLength(0); // tenant-y never pushed — isolated, not tenant-x's data
  });

  test("tenant/app identifiers with unsafe characters don't collide or escape the key namespace", async () => {
    const store = new InMemoryWorkspaceStore();
    const src = scratch();
    writeFileSync(join(src, "f.txt"), "a");
    await store.push("../../etc", "passwd", src);
    const pulled = await store.pull("../../etc", "passwd");
    tmps.push(pulled);
    expect(readFileSync(join(pulled, "f.txt"), "utf8")).toBe("a");
  });
});

// Real Tigris, gated (needs the AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_ENDPOINT_URL_S3/
// BUCKET_NAME secrets set — production has them; a local dev shell typically won't). Run:
//   VIBEHARD_INTEGRATION=1 bun test workspace-store.test
const run = process.env.VIBEHARD_INTEGRATION && process.env.BUCKET_NAME ? describe : describe.skip;
run("TigrisWorkspaceStore (real Tigris)", () => {
  test("push then pull round-trips real content through the real bucket", async () => {
    const bucket = process.env.BUCKET_NAME!;
    const store = new TigrisWorkspaceStore(bucket);
    const src = scratch();
    mkdirSync(join(src, "src"), { recursive: true });
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "integration-test" }));
    writeFileSync(join(src, "src", "index.ts"), `// ${Date.now()}\nexport {};\n`);

    const tenantId = "integration-test-tenant";
    const app = `app-${Date.now()}`;
    await store.push(tenantId, app, src);
    const pulled = await store.pull(tenantId, app);
    tmps.push(pulled);

    expect(readFileSync(join(pulled, "package.json"), "utf8")).toBe(JSON.stringify({ name: "integration-test" }));
    expect(readFileSync(join(pulled, "src", "index.ts"), "utf8")).toContain("export {};");
  }, 30_000);
});
