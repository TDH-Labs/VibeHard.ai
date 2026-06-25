import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBuildErrors, resolveLocalModule } from "./build-errors.ts";

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function project(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "vibehard-be-"));
  tmps.push(d);
  for (const [p, c] of Object.entries(files)) await Bun.write(join(d, p), c);
  return d;
}

const TSCONFIG = JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } });

describe("resolveLocalModule", () => {
  test("@/ alias → real file via tsconfig paths", async () => {
    const d = await project({ "tsconfig.json": TSCONFIG, "lib/supabase/admin.ts": "export function createAdminClient(){}" });
    expect(resolveLocalModule("@/lib/supabase/admin", d)).toBe("lib/supabase/admin.ts");
  });
  test("bare package specifier → null (it's an npm dep, not a file)", async () => {
    const d = await project({ "tsconfig.json": TSCONFIG });
    expect(resolveLocalModule("stripe", d)).toBeNull();
  });
  test("falls back to ./src when tsconfig is missing", async () => {
    const d = await project({ "src/lib/x.ts": "export const x = 1" });
    expect(resolveLocalModule("@/lib/x", d)).toBe("src/lib/x.ts");
  });
});

describe("parseBuildErrors", () => {
  test("'not exported' → finding pointed at the resolved module file (the live failure)", async () => {
    const d = await project({ "tsconfig.json": TSCONFIG, "lib/supabase/admin.ts": "export function createAdminClient(){}" });
    const log = "./app/actions/billing.ts\nAttempted import error: 'supabaseAdmin' is not exported from '@/lib/supabase/admin' (imported as 'supabaseAdmin').";
    const out = parseBuildErrors(log, d);
    expect(out).toHaveLength(1);
    expect(out[0]!.file).toBe("lib/supabase/admin.ts"); // not "package.json"
    expect(out[0]!.message).toContain("supabaseAdmin");
    expect(out[0]!.ruleId).toBe("build-failed");
  });

  test("TS 'has no exported member' → resolved file + symbol", async () => {
    const d = await project({ "tsconfig.json": TSCONFIG, "lib/supabase/admin.ts": "export function createAdminClient(){}" });
    const log = `Type error: Module '"@/lib/supabase/admin"' has no exported member 'supabaseAdmin'.`;
    const out = parseBuildErrors(log, d);
    expect(out[0]!.file).toBe("lib/supabase/admin.ts");
    expect(out[0]!.message).toContain("supabaseAdmin");
  });

  test("'Can't resolve PKG' stays verbatim so missingdeps still matches it", async () => {
    const d = await project({ "tsconfig.json": TSCONFIG });
    const out = parseBuildErrors("Module not found: Can't resolve 'stripe'", d);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain("Can't resolve 'stripe'");
  });

  test("unparseable log → no findings (caller falls back to the generic finding)", async () => {
    const d = await project({ "tsconfig.json": TSCONFIG });
    expect(parseBuildErrors("some unrecognized build noise", d)).toEqual([]);
  });

  test("ruleId override flows through (clean-verify path)", async () => {
    const d = await project({ "tsconfig.json": TSCONFIG });
    const out = parseBuildErrors("Module not found: Can't resolve 'svix'", d, "clean-verify-failed");
    expect(out[0]!.ruleId).toBe("clean-verify-failed");
  });
});
