#!/bin/sh
# Release = the platform image AND the E2B build-worker template, from the SAME commit, stamped.
#
# Why this script exists (2026-07-18, acceptance test scored 0/3): the worker template was
# published out-of-band once and then drifted a week stale while the platform kept deploying —
# every real user build ran old code. The .build-sha stamp written here lands in BOTH images
# (each Dockerfile's `COPY . .`), and build-worker.ts's dispatch-time handshake REFUSES a worker
# whose stamp doesn't match the platform's. Deploying only one half now fails loudly instead of
# silently serving stale builds.
set -e
cd "$(dirname "$0")/.."

# -uno: TRACKED changes only. The stamp names the committed tree; long-lived untracked scratch
# (audit notes, design docs) doesn't invalidate a release — uncommitted CODE edits do.
[ -z "$(git status --porcelain -uno)" ] || { echo "release.sh: uncommitted tracked changes — commit first" >&2; exit 1; }

git rev-parse HEAD > .build-sha
echo "release: stamping $(cat .build-sha)"

fly deploy -a vibehard-platform

# Requires E2B_API_KEY in the environment. `template create` REBUILDS an existing template by
# name (e2b CLI ≥2.x; the old `template build` verb is deprecated and — trap — exits 0 having
# done NOTHING but print a banner). CPU/memory must be restated or the rebuild would reset them
# to defaults (2 vCPU/1GB); 4/4096 matches the live template.
npx --yes @e2b/cli template create vibehard-build-worker -d e2b.Dockerfile --cpu-count 4 --memory-mb 4096

curl -sf -o /dev/null https://vibehard-platform.fly.dev/api/auth-config && echo "release: health ok"
echo "release: platform + worker template published from $(cat .build-sha)"
