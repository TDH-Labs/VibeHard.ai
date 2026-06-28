import { describe, expect, test } from "bun:test";
import { runInFlySandbox, type FlySandboxDeps } from "./fly-sandbox.ts";
import type { HostProvider } from "./types.ts";

/** A fake HostProvider that records deploy/teardown calls — no real Fly resources. */
function fakeHost(over: Partial<HostProvider> & { onTeardown?: (ref: string) => void } = {}) {
  const calls: string[] = [];
  const host: HostProvider = {
    name: "fake-fly",
    deploy: async (_w, _e, ref) => {
      calls.push(`deploy:${ref}`);
      return { url: "https://sbx.fly.dev", hostRef: ref ?? "sbx" };
    },
    teardown: async (ref) => {
      calls.push(`teardown:${ref}`);
      over.onTeardown?.(ref);
    },
    ...over,
  };
  return { host, calls };
}

const deps = (host: HostProvider, fetchImpl: FlySandboxDeps["fetchImpl"]): FlySandboxDeps => ({
  host,
  fetchImpl,
  name: () => "vibehard-sbx-test",
  probePaths: ["/"],
});

describe("runInFlySandbox — isolate build+boot, always tear down", () => {
  test("a healthy app → ok:true, and the ephemeral machine is torn down", async () => {
    const { host, calls } = fakeHost();
    const r = await runInFlySandbox("/ws", {}, deps(host, async () => ({ status: 200 })));
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(calls).toEqual(["deploy:vibehard-sbx-test", "teardown:vibehard-sbx-test"]);
  });

  test("an app that boots but serves 5xx → ok:false, STILL torn down", async () => {
    const { host, calls } = fakeHost();
    const r = await runInFlySandbox("/ws", {}, deps(host, async () => ({ status: 502 })));
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.startsWith("teardown:"))).toBe(true); // no leaked machine
  });

  test("a deploy/build failure → ok:false with the error, no teardown (nothing was created)", async () => {
    const { host, calls } = fakeHost({ deploy: async () => { throw new Error("docker build failed: missing Dockerfile"); } });
    const r = await runInFlySandbox("/ws", {}, deps(host, async () => ({ status: 200 })));
    expect(r.ok).toBe(false);
    expect(r.log).toMatch(/docker build failed/);
    expect(calls.some((c) => c.startsWith("teardown:"))).toBe(false);
  });

  test("teardown runs even if the probe throws (network error) — no leaked machine, no crash", async () => {
    let toreDown = false;
    const { host } = fakeHost({ onTeardown: () => { toreDown = true; } });
    const r = await runInFlySandbox("/ws", {}, deps(host, async () => { throw new Error("ECONNREFUSED"); }));
    expect(r.ok).toBe(false); // never came up
    expect(toreDown).toBe(true);
  });

  test("untrusted env is forwarded to the isolated deploy, never run on host", async () => {
    const seen: Array<Record<string, string>> = [];
    const host: HostProvider = {
      name: "fake",
      deploy: async (_w, env, ref) => { seen.push(env); return { url: "https://x.fly.dev", hostRef: ref ?? "x" }; },
      teardown: async () => {},
    };
    await runInFlySandbox("/ws", { STRIPE_SECRET_KEY: "tenant-key" }, deps(host, async () => ({ status: 200 })));
    expect(seen[0]).toEqual({ STRIPE_SECRET_KEY: "tenant-key" });
  });
});
