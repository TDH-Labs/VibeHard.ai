import { describe, expect, test } from "bun:test";
import { coerceQuestions, foldClarifications } from "./questions.ts";

describe("coerceQuestions — trust boundary", () => {
  test("takes {questions:[]}, trims, drops junk + empties, dedupes, caps at 5", () => {
    expect(coerceQuestions({ questions: ["  A?  ", "B?", "", 5, null, "A?", "C?", "D?", "E?", "F?", "G?"] })).toEqual(["A?", "B?", "C?", "D?", "E?"]);
  });
  test("accepts a bare array too", () => {
    expect(coerceQuestions(["one?", "two?"])).toEqual(["one?", "two?"]);
  });
  test("garbage → empty (questions are optional; the build proceeds)", () => {
    expect(coerceQuestions("not json")).toEqual([]);
    expect(coerceQuestions(null)).toEqual([]);
    expect(coerceQuestions({})).toEqual([]);
  });
});

describe("foldClarifications — pure", () => {
  const base = "A notes app";
  test("folds answered Q→A pairs into a Clarifications block", () => {
    const out = foldClarifications(base, [
      { q: "Multi-user?", a: "Yes, each sees their own" },
      { q: "Pay in app?", a: "No" },
    ]);
    expect(out).toContain("A notes app");
    expect(out).toContain("Clarifications from the user:");
    expect(out).toContain("- Multi-user? → Yes, each sees their own");
    expect(out).toContain("- Pay in app? → No");
  });
  test("drops blank answers", () => {
    const out = foldClarifications(base, [
      { q: "Q1?", a: "  " },
      { q: "Q2?", a: "answered" },
    ]);
    expect(out).not.toContain("Q1?");
    expect(out).toContain("- Q2? → answered");
  });
  test("no answers → original prompt unchanged", () => {
    expect(foldClarifications(base, [])).toBe(base);
    expect(foldClarifications(base, [{ q: "Q?", a: "" }])).toBe(base);
  });
});
