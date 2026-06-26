import { describe, expect, test } from "bun:test";
import { packageNameOf, parseMissingModules } from "./missingdeps.ts";
import type { Finding } from "../types.ts";

const verify = (message: string): Finding => ({ tool: "verify", ruleId: "build-failed", severity: "high", file: "package.json", message });

describe("packageNameOf", () => {
  test("plain package", () => expect(packageNameOf("stripe")).toBe("stripe"));
  test("scoped package", () => expect(packageNameOf("@stripe/react-stripe-js")).toBe("@stripe/react-stripe-js"));
  test("subpath import → bare package", () => expect(packageNameOf("date-fns/format")).toBe("date-fns"));
  test("scoped subpath → scope/name", () => expect(packageNameOf("@scope/pkg/deep/path")).toBe("@scope/pkg"));
  test("relative import → null", () => expect(packageNameOf("./lib/x")).toBeNull());
  test("parent import → null", () => expect(packageNameOf("../utils")).toBeNull());
  test("tsconfig @/ alias → null", () => expect(packageNameOf("@/components/Card")).toBeNull());
  test("node builtin → null", () => expect(packageNameOf("fs")).toBeNull());
  test("node: builtin → null", () => expect(packageNameOf("node:crypto")).toBeNull());
});

describe("parseMissingModules", () => {
  test("webpack 'Can't resolve' → the package", () => {
    expect(parseMissingModules([verify("`npm run build` exited 1 — Module not found: Can't resolve 'stripe'")])).toEqual(["stripe"]);
  });

  test("node 'Cannot find module' → the package", () => {
    expect(parseMissingModules([verify("Error: Cannot find module 'svix'")])).toEqual(["svix"]);
  });

  test("de-dupes across findings and ignores relative/builtin/alias specifiers", () => {
    const out = parseMissingModules([
      verify("Can't resolve 'date-fns-tz'"),
      verify("Can't resolve 'date-fns-tz'"), // dup
      verify("Can't resolve './local/thing'"), // relative
      verify("Can't resolve '@/components/X'"), // alias
      verify("Cannot find module 'fs'"), // builtin
      verify("Can't resolve '@stripe/react-stripe-js'"),
    ]);
    expect(out.sort()).toEqual(["@stripe/react-stripe-js", "date-fns-tz"]);
  });

  test("only reads verify findings (not sast/trivy/etc.)", () => {
    const sast: Finding = { tool: "semgrep", ruleId: "x", severity: "high", file: "a.ts", message: "Can't resolve 'leaked-from-other-tool'" };
    expect(parseMissingModules([sast])).toEqual([]);
  });
});

import { packageNameOf as pkgName } from "./missingdeps.ts";
describe("packageNameOf — path-ish / malformed specs are rejected (C3 defense-in-depth)", () => {
  test("relative, absolute, and scoped-with-traversal specs return null", () => {
    expect(pkgName("../evil")).toBeNull();
    expect(pkgName("/etc/passwd")).toBeNull();
    expect(pkgName("@org/..")).toBeNull(); // scoped name part now validated
    expect(pkgName("@org/")).toBeNull();
    expect(pkgName("react")).toBe("react"); // a real package still resolves
    expect(pkgName("@scope/pkg")).toBe("@scope/pkg");
  });
});
