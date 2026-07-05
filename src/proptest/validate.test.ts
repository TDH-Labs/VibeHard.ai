import { describe, expect, test } from "bun:test";
import { propTestFileName, propTestVacuityReason, requirementIdOf } from "./validate.ts";

const VALID = `// @requirement F1: sign in
import { describe, test } from "bun:test";
import fc from "fast-check";
import { validateEmail } from "../../lib/validate";

describe("F1 — sign in", () => {
  test("every valid email round-trips the validator", () => {
    fc.assert(fc.property(fc.emailAddress(), (e) => validateEmail(e) === true), { seed: 42 });
  });
});
`;

describe("propTestVacuityReason", () => {
  test("a real property test passes every guard", () => {
    expect(propTestVacuityReason(VALID)).toBeNull();
  });

  test("each missing ingredient is named", () => {
    expect(propTestVacuityReason(VALID.replace("// @requirement F1: sign in", ""))).toContain("@requirement");
    expect(propTestVacuityReason(VALID.replace('import fc from "fast-check";', ""))).toContain("fast-check");
    expect(propTestVacuityReason(VALID.replace(/fc\.assert/g, "console.log"))).toContain("fc.assert");
    expect(propTestVacuityReason(VALID.replace('import { validateEmail } from "../../lib/validate";', "const validateEmail=()=>true;"))).toContain("app module");
    expect(propTestVacuityReason(VALID.replace("{ seed: 42 }", "{}"))).toContain("seed");
  });

  test("a skipped test is vacuous — the neutering move a fixer would try", () => {
    expect(propTestVacuityReason(VALID.replace("test(", "test.skip("))).toContain("skip");
    expect(propTestVacuityReason(VALID.replace("test(", "test.todo("))).toContain("skip");
  });

  test("@/ path-alias imports count as app modules", () => {
    expect(propTestVacuityReason(VALID.replace('from "../../lib/validate"', 'from "@/lib/validate"'))).toBeNull();
  });
});

describe("file name ↔ requirement mapping", () => {
  test("requirement ids become safe file names", () => {
    expect(propTestFileName("F1")).toBe("f1.test.ts");
    expect(propTestFileName("REQ 2.3/auth")).toBe("req-2-3-auth.test.ts");
  });

  test("requirementIdOf reads the header back", () => {
    expect(requirementIdOf(VALID)).toBe("F1");
    expect(requirementIdOf("no header")).toBeNull();
  });
});
