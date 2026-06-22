/**
 * LIVE smoke — deploys a tiny static workspace to Vercel and tears it down. Proves the
 * deploy leg works end-to-end against the real platform. GUARDED: runs only with
 * DRYDOCK_INTEGRATION=1 and VERCEL_TOKEN present. Uses a preview deploy (lighter) and
 * removes the project in teardown.
 *
 *   DRYDOCK_INTEGRATION=1 bun test src/substrate/vercel.integration.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VercelHostProvider } from "./vercel.ts";

const RUN = !!process.env.DRYDOCK_INTEGRATION && !!process.env.VERCEL_TOKEN;
const maybe = RUN ? test : test.skip;

describe("LIVE smoke — VercelHostProvider deploys a static workspace", () => {
  maybe(
    "deploys and returns a live .vercel.app URL, then tears the project down",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "dd-vercel-smoke-"));
      writeFileSync(join(dir, "index.html"), "<!doctype html><title>drydock smoke</title><h1>drydock-smoke-ok</h1>");
      const provider = new VercelHostProvider({ prod: false }); // preview deploy
      let hostRef = "";
      try {
        const out = await provider.deploy(dir, {}, null);
        expect(out.url).toMatch(/^https:\/\/.+\.vercel\.app$/);
        hostRef = out.hostRef;
        console.log("deployed →", out.url, "| project:", hostRef);
        try {
          const r = await fetch(out.url, { redirect: "manual" });
          console.log("GET", out.url, "→", r.status); // may be gated by Vercel deployment protection; informational only
        } catch (e) {
          console.log("fetch note:", e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (hostRef) {
          try {
            await provider.teardown(hostRef);
            console.log("removed project:", hostRef);
          } catch (e) {
            console.log("teardown warning:", e instanceof Error ? e.message : String(e));
          }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    300000,
  );
});
