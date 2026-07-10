import { describe, expect, test } from "bun:test";
import { mergeConfigFile, mergePackageJson, mergeTsconfig, MERGEABLE_BASENAMES } from "./merge-config.ts";

describe("mergePackageJson — the incident this fixes: 2026-07-09 dogfooding", () => {
  test("union dependencies + devDependencies, no key collision → both survive", () => {
    const existing = JSON.stringify({ name: "app", dependencies: { commander: "^12" } });
    const incoming = JSON.stringify({ name: "app", dependencies: { zod: "^3" }, devDependencies: { typescript: "^5" } });
    const { merged, conflicts } = mergePackageJson(existing, incoming);
    const out = JSON.parse(merged);
    expect(out.dependencies).toEqual({ commander: "^12", zod: "^3" });
    expect(out.devDependencies).toEqual({ typescript: "^5" });
    expect(conflicts).toEqual([]);
  });

  test("union scripts, incoming wins on an exact key collision", () => {
    const existing = JSON.stringify({ scripts: { build: "tsc", test: "bun test" } });
    const incoming = JSON.stringify({ scripts: { build: "tsc -p .", lint: "eslint ." } });
    const { merged } = mergePackageJson(existing, incoming);
    const out = JSON.parse(merged);
    expect(out.scripts).toEqual({ build: "tsc -p .", test: "bun test", lint: "eslint ." });
  });

  test("THE REAL INCIDENT: main set by an earlier workstream survives a later workstream's conflicting overwrite", () => {
    // data-access set the correct downloadable-tool entry point first...
    const existing = JSON.stringify({ name: "app", main: "src/index.js" });
    // ...tui-framework's own codegen independently wrote a DIFFERENT (stale, tsc-requiring) value.
    const incoming = JSON.stringify({ name: "app", main: "dist/index.js" });
    const { merged, conflicts } = mergePackageJson(existing, incoming);
    const out = JSON.parse(merged);
    expect(out.main).toBe("src/index.js"); // the correct, earlier value — NOT silently reverted
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("main");
    expect(conflicts[0]).toContain("src/index.js");
    expect(conflicts[0]).toContain("dist/index.js");
  });

  test("main: only one side declares it → that value wins, no conflict", () => {
    const existing = JSON.stringify({ name: "app" });
    const incoming = JSON.stringify({ name: "app", main: "src/index.js" });
    const { merged, conflicts } = mergePackageJson(existing, incoming);
    expect(JSON.parse(merged).main).toBe("src/index.js");
    expect(conflicts).toEqual([]);
  });

  test("main: both sides agree → no conflict reported", () => {
    const existing = JSON.stringify({ main: "src/index.js" });
    const incoming = JSON.stringify({ main: "src/index.js" });
    const { conflicts } = mergePackageJson(existing, incoming);
    expect(conflicts).toEqual([]);
  });

  test("bin follows the identical existing-wins-on-conflict rule as main", () => {
    const existing = JSON.stringify({ bin: { mytool: "./cli.js" } });
    const incoming = JSON.stringify({ bin: { mytool: "./bin/cli.js" } });
    const { merged, conflicts } = mergePackageJson(existing, incoming);
    expect(JSON.parse(merged).bin).toEqual({ mytool: "./cli.js" });
    expect(conflicts).toHaveLength(1);
  });

  test("other scalar fields: existing wins if present, else incoming fills the gap", () => {
    const existing = JSON.stringify({ name: "app", type: "module" });
    const incoming = JSON.stringify({ name: "should-be-ignored", type: "commonjs", license: "MIT" });
    const { merged } = mergePackageJson(existing, incoming);
    const out = JSON.parse(merged);
    expect(out.name).toBe("app");
    expect(out.type).toBe("module");
    expect(out.license).toBe("MIT"); // existing never declared it — incoming fills the gap
  });

  test("malformed existing JSON → falls forward to incoming rather than blocking codegen", () => {
    const { merged, conflicts } = mergePackageJson("{not json", JSON.stringify({ name: "app" }));
    expect(JSON.parse(merged).name).toBe("app");
    expect(conflicts).toEqual([]);
  });

  test("malformed incoming JSON → keeps the existing good content", () => {
    const { merged } = mergePackageJson(JSON.stringify({ name: "app" }), "{not json");
    expect(JSON.parse(merged).name).toBe("app");
  });
});

describe("mergeTsconfig", () => {
  test("compilerOptions merge, incoming wins on collision; include/exclude union + de-dupe", () => {
    const existing = JSON.stringify({ compilerOptions: { strict: true, target: "es2020" }, include: ["src"] });
    const incoming = JSON.stringify({ compilerOptions: { target: "es2022", module: "esnext" }, include: ["src", "tests"], exclude: ["dist"] });
    const { merged } = mergeTsconfig(existing, incoming);
    const out = JSON.parse(merged);
    expect(out.compilerOptions).toEqual({ strict: true, target: "es2022", module: "esnext" });
    expect(out.include.sort()).toEqual(["src", "tests"]);
    expect(out.exclude).toEqual(["dist"]);
  });
});

describe("mergeConfigFile — dispatch by basename", () => {
  test("package.json and tsconfig.json are in MERGEABLE_BASENAMES; an arbitrary file is not", () => {
    expect(MERGEABLE_BASENAMES.has("package.json")).toBe(true);
    expect(MERGEABLE_BASENAMES.has("tsconfig.json")).toBe(true);
    expect(MERGEABLE_BASENAMES.has("src/index.ts")).toBe(false);
  });

  test("an unrecognized basename just returns incoming unchanged (defensive default)", () => {
    const { merged, conflicts } = mergeConfigFile("other.json", '{"a":1}', '{"b":2}');
    expect(merged).toBe('{"b":2}');
    expect(conflicts).toEqual([]);
  });
});
