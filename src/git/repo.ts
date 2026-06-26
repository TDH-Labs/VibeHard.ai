/**
 * A minimal Git seam for "git repo = shared state" (roadmap Phase 4). When an SWE edits the code in
 * their own editor and pushes, VibeHard must coordinate, not clobber. This wraps the handful of git
 * operations the coordination needs behind an INJECTABLE runner — so the turn-taking rules
 * (coordinate.ts) unit-test with a fake, and the live behavior (real `git`) is one thin impl.
 *
 * The cardinal rule lives here: pushFastForward NEVER force-pushes. A rejected push means the remote
 * moved (someone pushed) → the caller pulls + re-gates, it does not overwrite the human's work.
 */
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type GitRunner = (args: string[], cwd: string) => RunResult;

/** Real git via Bun.spawnSync. */
export const bunGitRunner: GitRunner = (args, cwd) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode, stdout: new TextDecoder().decode(r.stdout).trim(), stderr: new TextDecoder().decode(r.stderr).trim() };
};

export interface GitRepo {
  isRepo(): boolean;
  init(): void;
  head(): string | null;
  hasRemote(name?: string): boolean;
  fetch(remote?: string): boolean;
  /** sha of the tracking ref (e.g. origin/main) after a fetch, or null. */
  remoteHead(branch?: string, remote?: string): string | null;
  /** stage everything + commit; false if there was nothing to commit. */
  commitAll(message: string): boolean;
  /** push WITHOUT --force. `rejected` = the remote moved (a non-fast-forward) — do NOT clobber. */
  pushFastForward(branch?: string, remote?: string): { ok: boolean; rejected: boolean; reason: string };
  /** rebase local work onto the remote tip; `conflict` = both touched the same lines → hand off. */
  rebaseOntoRemote(branch?: string, remote?: string): { ok: boolean; conflict: boolean; reason: string };
}

export function gitRepo(dir: string, run: GitRunner = bunGitRunner): GitRepo {
  const g = (...args: string[]) => run(args, dir);
  return {
    isRepo: () => g("rev-parse", "--is-inside-work-tree").exitCode === 0,
    init: () => void g("init"),
    head: () => {
      const r = g("rev-parse", "HEAD");
      return r.exitCode === 0 && r.stdout ? r.stdout : null;
    },
    hasRemote: (name = "origin") =>
      g("remote")
        .stdout.split("\n")
        .map((s) => s.trim())
        .includes(name),
    fetch: (remote = "origin") => g("fetch", remote).exitCode === 0,
    remoteHead: (branch = "main", remote = "origin") => {
      const r = g("rev-parse", `${remote}/${branch}`);
      return r.exitCode === 0 && r.stdout ? r.stdout : null;
    },
    commitAll: (message) => {
      g("add", "-A");
      const r = g("-c", "user.email=vibehard@local", "-c", "user.name=VibeHard", "commit", "-m", message);
      // git exits non-zero with "nothing to commit" when the tree is clean — not an error here.
      return r.exitCode === 0;
    },
    pushFastForward: (branch = "main", remote = "origin") => {
      const r = g("push", remote, `HEAD:${branch}`); // NO --force, ever
      if (r.exitCode === 0) return { ok: true, rejected: false, reason: "pushed" };
      const rejected = /\b(rejected|non-fast-forward|fetch first|behind)\b/i.test(r.stderr + r.stdout);
      return { ok: false, rejected, reason: rejected ? "remote moved (non-fast-forward)" : r.stderr.split("\n")[0] || "push failed" };
    },
    rebaseOntoRemote: (branch = "main", remote = "origin") => {
      const r = g("rebase", `${remote}/${branch}`);
      if (r.exitCode === 0) return { ok: true, conflict: false, reason: "rebased onto remote" };
      const conflict = /\bconflict\b/i.test(r.stderr + r.stdout);
      if (conflict) g("rebase", "--abort"); // don't leave a half-rebased tree
      return { ok: false, conflict, reason: conflict ? "merge conflict — hand off to a human" : r.stderr.split("\n")[0] || "rebase failed" };
    },
  };
}
