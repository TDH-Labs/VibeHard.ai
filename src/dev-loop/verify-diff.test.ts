import { describe, expect, test } from "bun:test";
import { judgeDiff, type DiffAdversary } from "./verify-diff.ts";

describe("judgeDiff — the dev loop's second-pass adversary (§11 shape: adversary is injected, fake-testable)", () => {
  test("nothing staged → verified without ever calling the adversary", async () => {
    let called = false;
    const adversary: DiffAdversary = async () => {
      called = true;
      return { verified: true, notes: "" };
    };
    const v = await judgeDiff({ commitMessage: "x", diff: "" }, adversary);
    expect(v).toEqual({ verified: true, notes: "nothing staged — nothing to review." });
    expect(called).toBe(false);
  });

  test("adversary approves a diff that matches its message → verified", async () => {
    const adversary: DiffAdversary = async () => ({ verified: true, notes: "matches the stated fix, no scope creep." });
    const v = await judgeDiff({ commitMessage: "fix: X", diff: "diff --git a/x.ts ..." }, adversary);
    expect(v.verified).toBe(true);
    expect(v.notes).toMatch(/matches/);
  });

  test("THE CASE THIS EXISTS FOR: a green diff that quietly loosens a test → rejected", async () => {
    const adversary: DiffAdversary = async ({ diff }) => {
      // a real reviewer would notice the assertion got weaker, not that tests still pass
      if (diff.includes("toBeGreaterThan(0)") && diff.includes("- expect(x).toBe(5)")) {
        return { verified: false, notes: "the assertion was loosened from an exact match to toBeGreaterThan(0) — the commit message claims a fix, not a test weakening." };
      }
      return { verified: true, notes: "" };
    };
    const v = await judgeDiff(
      { commitMessage: "fix: correct the count", diff: "- expect(x).toBe(5)\n+ expect(x).toBeGreaterThan(0)" },
      adversary,
    );
    expect(v.verified).toBe(false);
    expect(v.notes).toMatch(/loosened/);
  });

  test("adversary throws (provider hiccup) → fails OPEN, never reverts good work over a transient error", async () => {
    const adversary: DiffAdversary = async () => {
      throw new Error("Upstream error from Ambient: Upstream error");
    };
    const v = await judgeDiff({ commitMessage: "fix: X", diff: "diff --git a/x.ts ..." }, adversary);
    expect(v.verified).toBe(true);
    expect(v.notes).toMatch(/review unavailable/);
    expect(v.notes).toMatch(/Upstream error/);
  });
});
