import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DERIVED_DIRS, hasAuthoredSource } from "./scan-scope.ts";

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function scratch(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "drydock-scope-"));
  tmps.push(d);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(d, path), content);
  return d;
}

describe("DERIVED_DIRS", () => {
  test("covers the full derived/build set (not just .next)", () => {
    const dirs: readonly string[] = DERIVED_DIRS;
    for (const d of ["node_modules", ".next", "dist", "build", "out", "coverage", ".turbo", ".git"]) {
      expect(dirs).toContain(d);
    }
  });
});

describe("hasAuthoredSource (§11 fail-closed guard)", () => {
  test("true when an authored source file exists (root or nested)", async () => {
    expect(hasAuthoredSource(await scratch({ "server.js": "x" }))).toBe(true);
    expect(hasAuthoredSource(await scratch({ "app/page.tsx": "x", "package.json": "{}" }))).toBe(true);
  });

  test("FALSE when only derived/build output is present (the exclusion-ate-everything case)", async () => {
    expect(hasAuthoredSource(await scratch({ ".next/server/app/page.js": "leaked", "node_modules/x/i.js": "y" }))).toBe(false);
  });

  test("false for an empty or missing dir", async () => {
    expect(hasAuthoredSource(await scratch({}))).toBe(false);
    expect(hasAuthoredSource(join(tmpdir(), "drydock-does-not-exist-xyz"))).toBe(false);
  });

  test("authored source nested alongside derived dirs is still found", async () => {
    expect(hasAuthoredSource(await scratch({ "node_modules/x/i.js": "y", ".next/c.js": "z", "src/main.ts": "ok" }))).toBe(true);
  });
});
