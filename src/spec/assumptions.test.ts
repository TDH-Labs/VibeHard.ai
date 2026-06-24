import { describe, expect, test } from "bun:test";
import { coerceAssumptions, foldAssumptions } from "./assumptions.ts";

describe("coerceAssumptions (trust boundary)", () => {
  test("caps at 6, drops non-strings/blanks, dedupes, trims", () => {
    expect(coerceAssumptions({ assumptions: [" a ", "a", "b", 3, "", null, "c", "d", "e", "f", "g", "h"] })).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
  test("accepts a bare array and garbage → []", () => {
    expect(coerceAssumptions(["x", "y"])).toEqual(["x", "y"]);
    expect(coerceAssumptions("nope")).toEqual([]);
    expect(coerceAssumptions({ assumptions: "nope" })).toEqual([]);
    expect(coerceAssumptions(null)).toEqual([]);
  });
});

describe("foldAssumptions (pure)", () => {
  test("folds confirmed/corrected statements into the prompt", () => {
    const out = foldAssumptions("build a portal", [{ text: "Clients have their own login." }, { text: "Each therapist sees only their own clients." }]);
    expect(out).toContain("build a portal");
    expect(out).toContain("Confirmed details about the app:");
    expect(out).toContain("- Clients have their own login.");
    expect(out).toContain("- Each therapist sees only their own clients.");
  });
  test("drops blank entries; none → original prompt unchanged", () => {
    expect(foldAssumptions("p", [{ text: "  " }, { text: "kept" }])).toBe("p\n\nConfirmed details about the app:\n- kept");
    expect(foldAssumptions("p", [])).toBe("p");
    expect(foldAssumptions("p", [{ text: "" }])).toBe("p");
  });
});
