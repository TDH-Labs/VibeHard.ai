import { describe, expect, test } from "bun:test";
import { coerceStep, foldInterview, type InterviewTurn } from "./interview.ts";

describe("coerceStep (trust boundary)", () => {
  test("a well-formed question step", () => {
    expect(coerceStep({ done: false, question: { question: " Who logs in? ", recommended: " Just your team " } })).toEqual({
      done: false,
      question: { question: "Who logs in?", recommended: "Just your team" },
    });
  });
  test("done:true → stop", () => {
    expect(coerceStep({ done: true })).toEqual({ done: true, question: null });
  });
  test("missing/blank question → done (never invents a question)", () => {
    expect(coerceStep({ done: false, question: { question: "  ", recommended: "x" } })).toEqual({ done: true, question: null });
    expect(coerceStep({})).toEqual({ done: true, question: null });
    expect(coerceStep("garbage")).toEqual({ done: true, question: null });
    expect(coerceStep(null)).toEqual({ done: true, question: null });
  });
  test("tolerates a flattened shape (question/recommended at top level)", () => {
    expect(coerceStep({ question: "Q?", recommended: "R" })).toEqual({ done: false, question: { question: "Q?", recommended: "R" } });
  });
});

describe("foldInterview (pure)", () => {
  const turns: InterviewTurn[] = [
    { question: "Who logs in?", answer: "Just therapists" },
    { question: "Can each therapist see all clients?", answer: "No, only their own" },
  ];
  test("folds answered turns into the prompt", () => {
    const out = foldInterview("a notes app", turns);
    expect(out).toContain("a notes app");
    expect(out).toContain("Confirmed details about the app:");
    expect(out).toContain("- Who logs in? → Just therapists");
    expect(out).toContain("- Can each therapist see all clients? → No, only their own");
  });
  test("drops blank answers; none → original prompt", () => {
    expect(foldInterview("p", [{ question: "Q?", answer: "  " }])).toBe("p");
    expect(foldInterview("p", [])).toBe("p");
  });
});
