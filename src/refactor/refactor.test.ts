import { describe, expect, test } from "bun:test";
import { coerceRefactorBrief, refactorPhase, type Checkpointer, type RefactorBrief, type RefactorOptions } from "./refactor.ts";

/** A fake checkpointer that records save/restore/cleanup calls (no real I/O). */
function fakeCheckpointer(): Checkpointer & { saves: number; restores: number } {
  const state = { saves: 0, restores: 0 };
  return {
    get saves() {
      return state.saves;
    },
    get restores() {
      return state.restores;
    },
    save() {
      state.saves++;
      return `backup-${state.saves}`;
    },
    restore() {
      state.restores++;
    },
    cleanup() {},
  };
}

const brief = (n: number): RefactorBrief => ({ targets: Array.from({ length: n }, (_, i) => ({ file: `f${i}.ts`, issue: "x" })), summary: `${n} target(s)` });

function opts(over: Partial<RefactorOptions>): RefactorOptions {
  return {
    scorer: async () => brief(1),
    refactorer: async () => {},
    verify: async () => true,
    checkpoint: fakeCheckpointer(),
    ...over,
  };
}

describe("refactorPhase — skill proposes, re-verify disposes", () => {
  test("a refactor that keeps the build green → accepted; new checkpoint taken", async () => {
    const cp = fakeCheckpointer();
    const r = await refactorPhase("/ws", opts({ checkpoint: cp, scorer: async () => brief(2), verify: async () => true, budget: 1 }));
    expect(r).toMatchObject({ passes: 1, accepted: 1, rejected: 0 });
    expect(cp.restores).toBe(0);
    expect(cp.saves).toBe(2); // initial known-good + the new known-good after accept
  });

  test("THE IRON RULE: a refactor that breaks the build → reverted, and the phase stops", async () => {
    const cp = fakeCheckpointer();
    let refactored = 0;
    const r = await refactorPhase("/ws", opts({ checkpoint: cp, refactorer: async () => void refactored++, verify: async () => false, budget: 2 }));
    expect(r).toMatchObject({ passes: 1, accepted: 0, rejected: 1 });
    expect(cp.restores).toBe(1); // reverted to the passing tree
    expect(refactored).toBe(1); // stopped after the first break — didn't gamble the 2nd pass
  });

  test("nothing worth refactoring → no passes", async () => {
    let refactored = 0;
    const r = await refactorPhase("/ws", opts({ scorer: async () => brief(0), refactorer: async () => void refactored++ }));
    expect(r.passes).toBe(0);
    expect(refactored).toBe(0);
  });

  test("bounded to the budget when every pass stays green", async () => {
    const r = await refactorPhase("/ws", opts({ scorer: async () => brief(1), verify: async () => true, budget: 2 }));
    expect(r.passes).toBe(2);
    expect(r.accepted).toBe(2);
  });

  test("the LLM (scorer) can't force acceptance — only verify decides", async () => {
    // scorer always finds work, refactorer always 'fixes', but verify says broken → never accepted
    const r = await refactorPhase("/ws", opts({ verify: async () => false, budget: 2 }));
    expect(r.accepted).toBe(0);
  });
});

describe("coerceRefactorBrief — trust boundary", () => {
  test("coerces valid targets, drops malformed, defaults the summary", () => {
    const b = coerceRefactorBrief({ targets: [{ file: "a.ts", issue: "dup" }, { nope: 1 }, "junk"], summary: "  " });
    expect(b.targets).toEqual([{ file: "a.ts", issue: "dup" }]);
    expect(b.summary).toBe("1 quality target(s)"); // blank summary → derived
  });

  test("garbage → empty brief", () => {
    expect(coerceRefactorBrief(null)).toEqual({ targets: [], summary: "0 quality target(s)" });
  });
});
