#!/usr/bin/env bash
#
# Deterministic reliability harness for the `vibehard-launch-loop` autonomous agent.
#
# THE GUARANTEE: every run STARTS from the last green commit (any leftover WIP is
# reverted) and ENDS clean (a new green commit, or fully reverted). Combined with the
# pre-commit hook (blocks red commits) and LOOP_BACKLOG.md (atomic one-run tasks),
# thrashing is structurally impossible — the worst case is a wasted run that the next
# `start` cleans up. The agent's discipline is NOT trusted; these mechanics enforce it.
#
# Usage (the agent calls exactly these):
#   bash scripts/loop-run.sh start                 # clean + branch + print baseline & next task
#   bash scripts/loop-run.sh finish "<commit msg>" # verify → commit (green) or revert (red)
#   bash scripts/loop-run.sh verify                # typecheck + test (exit code = signal)
#   bash scripts/loop-run.sh abort  "<why>"        # emergency: revert + release lock
#
set -uo pipefail   # NOTE: not -e; we handle failures explicitly so cleanup always runs.

REPO="/Users/ai/dev/drydock"
BRANCH="fix/build-correctness-and-diagnose"
LOCK="$REPO/.loop.lock"            # atomic mkdir lock (portable; macOS has no flock)
RUNLOG="$REPO/.loop/journal.log"   # gitignored per-run telemetry (every run, no commit)
NOTES="$REPO/LOOP_NOTES.md"        # committed milestone journal (DONE entries only)
STALE_MIN=90                       # steal the lock if older than this (a crashed run)

cd "$REPO" || { echo "FATAL: cannot cd $REPO"; exit 1; }
mkdir -p "$REPO/.loop"

ts()  { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { printf '%s  %s\n' "$(ts)" "$*" >> "$RUNLOG"; }
release_lock() { rmdir "$LOCK" 2>/dev/null || true; }

verify() {
  echo "[loop] typecheck…"; bun run typecheck || return 1
  echo "[loop] tests…";     bun test          || return 1
  return 0
}

revert_all() {
  # Revert tracked changes (staged + unstaged) to HEAD. Leaves UNTRACKED files alone
  # (so docs / landing assets / .loop are never destroyed). Never runs `git clean`.
  git restore --staged --worktree . 2>/dev/null || git checkout -- . 2>/dev/null || true
}

case "${1:-}" in
  start)
    # ---- single-run lock (steal if stale) ----
    if ! mkdir "$LOCK" 2>/dev/null; then
      if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +$STALE_MIN 2>/dev/null)" ]; then
        log "LOCK stale → stealing"; rmdir "$LOCK" 2>/dev/null || true; mkdir "$LOCK" 2>/dev/null || true
      else
        echo "LOCKED: another run is active (<${STALE_MIN}m). Exiting."; log "LOCKED — skipped"; exit 3
      fi
    fi
    # ---- branch (never main) ----
    if ! git rev-parse --abbrev-ref HEAD | grep -qx "$BRANCH"; then
      git checkout "$BRANCH" || { echo "FATAL: cannot checkout $BRANCH"; release_lock; exit 1; }
    fi
    # ---- self-healing: ensure the pre-commit backstop is active in this clone ----
    git config core.hooksPath scripts/githooks
    # ---- UNCONDITIONAL clean start: revert leftover WIP from any crashed prior run ----
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
      revert_all
      log "RECOVERED — reverted leftover WIP from a prior crashed run"
      echo "RECOVERED: reverted leftover WIP before starting clean."
    fi
    log "START @ $(git rev-parse --short HEAD)"
    echo "BASELINE $(git rev-parse --short HEAD) on $BRANCH (clean)"
    echo "--- next task (top unchecked item in LOOP_BACKLOG.md) ---"
    grep -n -m1 '^- \[ \]' LOOP_BACKLOG.md 2>/dev/null || echo "(no open backlog items — see LOOP_BACKLOG.md)"
    ;;

  finish)
    msg="${2:-}"
    if [ -z "$msg" ]; then echo "usage: loop-run.sh finish \"<commit message>\""; exit 2; fi
    # Untracked CODE files under the source roots = an incomplete commit waiting to happen
    # (bit twice: 65b8c38 shipped importing a file that was never staged; CI caught it, local
    # tests didn't — the file existed on disk). Refuse until they're explicitly added or removed.
    untracked_src="$(git ls-files --others --exclude-standard -- src web scripts 2>/dev/null)"
    if [ -n "$untracked_src" ]; then
      echo "REFUSED: untracked files under src/web/scripts — \`git add\` them (or delete them) first:"
      echo "$untracked_src" | sed 's/^/  /'
      log "REFUSED-UNTRACKED — $msg"
      exit 4
    fi
    git add -u   # stage modified TRACKED files only — never untracked junk. New files: agent `git add`s them first.
    if git diff --cached --quiet; then
      echo "NOOP: nothing staged to commit."; log "NOOP — $msg"; revert_all; release_lock; exit 0
    fi
    if verify; then
      # ---- second-pass adversary: green ≠ right. An independent model reads the actual
      # staged diff against the actual commit message — catches a plausible-looking wrong
      # fix, scope creep, or a quietly-loosened assertion that `verify` can't see (it only
      # knows red/green, not whether green means what the message claims). Fails OPEN on a
      # call failure (src/dev-loop/verify-diff.ts) — only a considered rejection reverts.
      echo "[loop] adversarial second-pass review…"
      review_output="$(bun src/dev-loop/verify-diff.ts "$msg" 2>&1)"; review_exit=$?
      echo "$review_output"
      if [ "$review_exit" -eq 0 ]; then
        printf '\n## %s — DONE\n%s\n%s\n' "$(ts)" "$msg" "$review_output" >> "$NOTES"
        git add "$NOTES"
        if git commit -m "$msg"; then          # pre-commit hook re-verifies (defense in depth)
          echo "COMMITTED $(git rev-parse --short HEAD)"; log "DONE — $msg @ $(git rev-parse --short HEAD) — $review_output"
        else
          echo "COMMIT BLOCKED by hook — reverting."; revert_all; log "BLOCKED-BY-HOOK — $msg"
        fi
      else
        revert_all
        echo "REVERTED: adversarial review rejected this diff — $review_output"
        log "REVERTED (review-rejected) — $msg — $review_output"
      fi
    else
      revert_all
      echo "REVERTED: verify failed (typecheck/test red). WIP discarded; tree clean."
      log "REVERTED (red) — $msg"
    fi
    release_lock
    ;;

  verify) verify; exit $? ;;

  abort)
    revert_all; log "ABORT — ${2:-manual}"; release_lock
    echo "Aborted: tree reverted, lock released."
    ;;

  *) echo "usage: loop-run.sh {start | finish \"<msg>\" | verify | abort [why]}"; exit 2 ;;
esac
