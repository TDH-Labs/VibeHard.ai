import { describe, expect, test } from "bun:test";
import { gitRepo, type GitRepo, type GitRunner, type RunResult } from "./repo.ts";
import { commitAndPush, pullLatest, remoteAhead } from "./coordinate.ts";

/** A configurable fake GitRepo for the coordination rules. */
function fakeRepo(over: Partial<GitRepo> = {}): GitRepo {
  return {
    isRepo: () => true,
    init: () => {},
    head: () => "localsha",
    hasRemote: () => true,
    fetch: () => true,
    remoteHead: () => "localsha",
    commitAll: () => true,
    pushFastForward: () => ({ ok: true, rejected: false, reason: "pushed" }),
    rebaseOntoRemote: () => ({ ok: true, conflict: false, reason: "rebased" }),
    ...over,
  };
}

describe("commitAndPush — never clobbers the human", () => {
  test("clean fast-forward → pushed", () => {
    const r = commitAndPush(fakeRepo(), "fix");
    expect(r).toMatchObject({ pushed: true, remoteMoved: false, committed: true });
  });
  test("non-fast-forward (someone pushed) → remoteMoved, NOT a force push", () => {
    const r = commitAndPush(fakeRepo({ pushFastForward: () => ({ ok: false, rejected: true, reason: "non-fast-forward" }) }), "fix");
    expect(r.pushed).toBe(false);
    expect(r.remoteMoved).toBe(true); // caller must pull + re-gate, never force
    expect(r.reason).toMatch(/pull \+ re-gate/i);
  });
  test("no remote configured → commit only", () => {
    const r = commitAndPush(fakeRepo({ hasRemote: () => false }), "fix");
    expect(r).toMatchObject({ pushed: false, remoteMoved: false, committed: true });
  });
});

describe("pullLatest — integrate the SWE's work, hand off on conflict", () => {
  test("clean rebase → pulled", () => {
    expect(pullLatest(fakeRepo())).toMatchObject({ pulled: true, conflict: false });
  });
  test("merge conflict → hand off (do not auto-resolve)", () => {
    const r = pullLatest(fakeRepo({ rebaseOntoRemote: () => ({ ok: false, conflict: true, reason: "conflict" }) }));
    expect(r).toMatchObject({ pulled: false, conflict: true });
  });
});

describe("remoteAhead — a push wakes the loop", () => {
  test("remote tip differs from local → the SWE pushed", () => {
    expect(remoteAhead(fakeRepo({ head: () => "a", remoteHead: () => "b" }))).toBe(true);
    expect(remoteAhead(fakeRepo({ head: () => "a", remoteHead: () => "a" }))).toBe(false);
  });
});

describe("gitRepo (real impl over a fake runner) — the cardinal safety rule", () => {
  test("pushFastForward NEVER passes --force, and detects a non-fast-forward rejection", () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args): RunResult => {
      calls.push(args);
      if (args[0] === "push") return { exitCode: 1, stdout: "", stderr: "! [rejected] main -> main (non-fast-forward)" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = gitRepo("/x", runner).pushFastForward();
    expect(calls.some((a) => a.includes("--force") || a.includes("-f"))).toBe(false); // the whole point
    expect(r).toMatchObject({ ok: false, rejected: true });
  });
});
