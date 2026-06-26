/**
 * Turn-taking coordination for "git repo = shared state" (roadmap Phase 4). The rules that make
 * bring-your-own-editor SAFE: VibeHard and the SWE are never both writing at once; the remote HEAD is
 * the merge point; VibeHard NEVER force-pushes. When the remote moved (the SWE pushed), VibeHard
 * pulls + re-gates instead of clobbering; a real conflict hands off to a human.
 *
 * Pure functions over the GitRepo seam → unit-tested with a fake; no live git in the tests.
 */
import type { GitRepo } from "./repo.ts";

export interface SyncOutcome {
  pushed: boolean;
  /** the remote moved (someone pushed) — the caller must pull + re-gate, NOT force-push over it. */
  remoteMoved: boolean;
  committed: boolean;
  reason: string;
}

/** Commit local work and push fast-forward-only. On a non-fast-forward, surface remoteMoved so the
 *  loop reconciles instead of clobbering the human's commits. */
export function commitAndPush(repo: GitRepo, message: string): SyncOutcome {
  const committed = repo.commitAll(message);
  if (!repo.hasRemote()) return { pushed: false, remoteMoved: false, committed, reason: committed ? "committed (no remote configured)" : "nothing to commit" };
  const r = repo.pushFastForward();
  if (r.ok) return { pushed: true, remoteMoved: false, committed, reason: committed ? "committed + pushed" : "already up to date" };
  if (r.rejected) return { pushed: false, remoteMoved: true, committed, reason: "remote moved (someone pushed) — pull + re-gate, never force" };
  return { pushed: false, remoteMoved: false, committed, reason: r.reason };
}

export interface PullOutcome {
  pulled: boolean;
  /** both sides edited the same lines — hand off to a human; do NOT auto-resolve in the loop. */
  conflict: boolean;
  reason: string;
}

/** Bring an SWE's pushes in before the loop works again: fetch + rebase local work onto remote HEAD. */
export function pullLatest(repo: GitRepo): PullOutcome {
  if (!repo.hasRemote()) return { pulled: false, conflict: false, reason: "no remote" };
  if (!repo.fetch()) return { pulled: false, conflict: false, reason: "fetch failed" };
  const r = repo.rebaseOntoRemote();
  if (r.ok) return { pulled: true, conflict: false, reason: "rebased onto the latest remote" };
  return { pulled: false, conflict: r.conflict, reason: r.reason };
}

/** Has the SWE pushed work we don't have locally yet? (remote tip differs from local HEAD after a
 *  fetch). Used to wake a held/idle loop: a push → pull → re-gate. */
export function remoteAhead(repo: GitRepo): boolean {
  if (!repo.hasRemote() || !repo.fetch()) return false;
  const local = repo.head();
  const remote = repo.remoteHead();
  return !!remote && remote !== local;
}
