import { beforeEach, describe, expect, test } from "bun:test";
import { clearDigestCache, pinDockerfileDigests, type FetchLike } from "./docker-pin.ts";

beforeEach(() => clearDigestCache()); // the cache is process-lifetime by design — isolate cases

const REAL_DIGEST = "sha256:" + "a".repeat(64);
const FAKE_DIGEST = "sha256:" + "c".repeat(64);

/** A fake registry: token endpoint always succeeds, manifest endpoint returns REAL_DIGEST
 *  for any repository/tag it's asked about (unless `unresolvable` names it). */
function fakeRegistry(opts: { unresolvable?: Set<string> } = {}): FetchLike {
  return async (url) => {
    if (url.includes("auth.docker.io/token")) {
      return { ok: true, headers: { get: () => null }, json: async () => ({ token: "t" }) };
    }
    const repo = /\/v2\/(.+)\/manifests\//.exec(url)?.[1] ?? "";
    if (opts.unresolvable?.has(repo)) {
      return { ok: false, headers: { get: () => null }, json: async () => ({}) };
    }
    return { ok: true, headers: { get: (n: string) => (n === "docker-content-digest" ? REAL_DIGEST : null) }, json: async () => ({}) };
  };
}

describe("pinDockerfileDigests", () => {
  test("replaces a fabricated digest with the real, resolved one", async () => {
    const dockerfile = `FROM alpine:3.19@sha256:${"c".repeat(64)}\nRUN apk add --no-cache nodejs npm\n`;
    const { content, changed } = await pinDockerfileDigests(dockerfile, fakeRegistry());
    expect(changed).toBe(true);
    expect(content).toContain(`FROM alpine:3.19@${REAL_DIGEST}`);
    expect(content).not.toContain(FAKE_DIGEST);
  });

  test("pins an unpinned tag that has no digest at all", async () => {
    const dockerfile = "FROM oven/bun:1\nWORKDIR /app\n";
    const { content, changed } = await pinDockerfileDigests(dockerfile, fakeRegistry());
    expect(changed).toBe(true);
    expect(content).toContain(`FROM oven/bun:1@${REAL_DIGEST}`);
  });

  test("defaults an untagged image to :latest before resolving", async () => {
    const dockerfile = "FROM alpine\n";
    const calls: string[] = [];
    const spy: FetchLike = async (url, init) => {
      calls.push(url);
      return fakeRegistry()(url, init);
    };
    const { content } = await pinDockerfileDigests(dockerfile, spy);
    expect(calls.some((u) => u.includes("/manifests/latest"))).toBe(true);
    expect(content).toContain(`FROM alpine:latest@${REAL_DIGEST}`);
  });

  test("leaves a multi-stage reference to an earlier build stage untouched", async () => {
    const dockerfile = "FROM node:22 AS builder\nRUN npm install\nFROM builder\nCOPY --from=builder /app /app\n";
    const { content } = await pinDockerfileDigests(dockerfile, fakeRegistry());
    expect(content).toContain("FROM builder\n"); // no lookup attempted on the stage name itself
    expect(content).toContain(`FROM node:22@${REAL_DIGEST} AS builder`);
  });

  test("leaves the line alone when resolution fails (offline, private registry, bad ref) — never guesses", async () => {
    const dockerfile = "FROM myprivateregistry.internal/app:1.0\n";
    const { content, changed } = await pinDockerfileDigests(dockerfile, fakeRegistry({ unresolvable: new Set(["app"]) }));
    expect(changed).toBe(false);
    expect(content).toBe(dockerfile);
  });

  test("a FROM with --platform is still pinned (fixer-rewritten Dockerfiles use it)", async () => {
    const { content, changed } = await pinDockerfileDigests("FROM --platform=linux/amd64 node:20-alpine AS base\n", fakeRegistry());
    expect(changed).toBe(true);
    expect(content).toContain(`FROM --platform=linux/amd64 node:20-alpine@${REAL_DIGEST} AS base`);
  });

  test("unresolvable refs are REPORTED, not silently skipped (cost a live diagnosis 2026-07-05)", async () => {
    const { unresolved } = await pinDockerfileDigests("FROM myprivateregistry.internal/app:1.0\nFROM alpine:3.19\n", fakeRegistry({ unresolvable: new Set(["app"]) }));
    expect(unresolved).toEqual(["myprivateregistry.internal/app:1.0"]);
  });

  test("a thrown fetch (network down) is swallowed — the line is left as-is, not crashed on", async () => {
    const dockerfile = "FROM alpine:3.19\n";
    const boom: FetchLike = async () => {
      throw new Error("network down");
    };
    const { content, changed } = await pinDockerfileDigests(dockerfile, boom);
    expect(changed).toBe(false);
    expect(content).toBe(dockerfile);
  });
});
