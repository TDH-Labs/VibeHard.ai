import { describe, expect, test } from "bun:test";
import { devCommand, parsePreviewUrl } from "./preview.ts";

describe("devCommand", () => {
  test("prefers the package's own dev script", () => {
    expect(devCommand({ scripts: { dev: "next dev" } })).toEqual({ cmd: "npm", args: ["run", "dev"] });
  });
  test("falls back to framework default when there's no dev script", () => {
    expect(devCommand({ dependencies: { next: "15" } })).toEqual({ cmd: "npx", args: ["next", "dev"] });
    expect(devCommand({ devDependencies: { vite: "5" } })).toEqual({ cmd: "npx", args: ["vite"] });
    expect(devCommand(null)).toEqual({ cmd: "npm", args: ["start"] });
  });
});

describe("parsePreviewUrl", () => {
  test("extracts the localhost URL a dev server advertises", () => {
    expect(parsePreviewUrl("   - Local:        http://localhost:3000")).toBe("http://localhost:3000");
    expect(parsePreviewUrl("  ➜  Local:   http://localhost:5173/")).toBe("http://localhost:5173/");
    expect(parsePreviewUrl("ready on http://127.0.0.1:3100.")).toBe("http://127.0.0.1:3100"); // trailing punctuation stripped
  });
  test("returns null on a line with no URL", () => {
    expect(parsePreviewUrl("Compiling /middleware ...")).toBeNull();
    expect(parsePreviewUrl("http://example.com is not localhost")).toBeNull();
  });
});
