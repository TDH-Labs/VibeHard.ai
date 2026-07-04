import { describe, expect, test } from "bun:test";
import { coerceStep, foldInterview, llmInterviewer, type InterviewTurn } from "./interview.ts";

describe("coerceStep (trust boundary)", () => {
  test("a well-formed question step (options default to [])", () => {
    expect(coerceStep({ done: false, question: { question: " Who logs in? ", recommended: " Just your team " } })).toEqual({
      done: false,
      question: { question: "Who logs in?", options: [], recommended: "Just your team" },
    });
  });
  test("parses multiple-choice options (label + detail, deduped, capped)", () => {
    const step = coerceStep({
      done: false,
      question: {
        question: "Which slice of ProCare should I build first?",
        recommended: "Admin dashboard",
        options: [
          { label: "Admin dashboard", detail: "Staff-facing: children, attendance, billing" },
          { label: "Parent portal", description: "Parents see daily reports + invoices" },
          { label: "Admin dashboard", detail: "dup dropped" },
          "Marketing site",
        ],
      },
    });
    expect(step.question!.options).toEqual([
      { label: "Admin dashboard", detail: "Staff-facing: children, attendance, billing" },
      { label: "Parent portal", detail: "Parents see daily reports + invoices" }, // tolerates "description"
      { label: "Marketing site", detail: "" }, // tolerates a bare string
    ]);
    expect(step.question!.recommended).toBe("Admin dashboard");
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
    expect(coerceStep({ question: "Q?", recommended: "R" })).toEqual({ done: false, question: { question: "Q?", options: [], recommended: "R" } });
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

describe("llmInterviewer hardening (injected generate)", () => {
  const Q = JSON.stringify({ done: false, question: { question: "Who logs in?", options: [], recommended: "Just you" } });
  const DONE = JSON.stringify({ done: true });

  test("a transient error retries once instead of skipping the interview", async () => {
    let calls = 0;
    const interviewer = llmInterviewer({
      generate: async () => {
        calls++;
        if (calls === 1) throw new Error("502 from gateway");
        return Q;
      },
    });
    const step = await interviewer("a client portal with logins", []);
    expect(calls).toBe(2);
    expect(step.done).toBe(false);
    expect(step.question?.question).toBe("Who logs in?");
  });

  test("two consecutive errors fail safe to done (build never blocks)", async () => {
    const interviewer = llmInterviewer({ generate: async () => { throw new Error("down"); } });
    expect(await interviewer("anything", [])).toEqual({ done: true, question: null });
  });

  test("done with ZERO questions is challenged once — a real question on the second ask wins", async () => {
    const answers = [DONE, Q];
    let sawNudge = false;
    const interviewer = llmInterviewer({
      generate: async (_system, prompt) => {
        if (prompt.includes("WITHOUT ASKING A SINGLE QUESTION")) sawNudge = true;
        return answers.shift()!;
      },
    });
    const step = await interviewer("a portal where clients see their own invoices", []);
    expect(sawNudge).toBe(true);
    expect(step.done).toBe(false);
  });

  test("done at zero stands only if the model repeats it under protest (trivial tool)", async () => {
    const interviewer = llmInterviewer({ generate: async () => DONE });
    expect(await interviewer("a page that shows the current time", [])).toEqual({ done: true, question: null });
  });

  test("done AFTER questions were asked is accepted without a challenge", async () => {
    let calls = 0;
    const interviewer = llmInterviewer({ generate: async () => { calls++; return DONE; } });
    const step = await interviewer("an app", [{ question: "Who logs in?", answer: "Just me" }, { question: "Payments?", answer: "No" }, { question: "Edge case?", answer: "None" }]);
    expect(calls).toBe(1);
    expect(step.done).toBe(true);
  });
});
