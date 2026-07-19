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

[ -z "$(git status --porcelain)" ] || { echo "release.sh: working tree dirty — commit first" >&2; exit 1; }

git rev-parse HEAD > .build-sha
echo "release: stamping $(cat .build-sha)"

fly deploy -a vibehard-platform

# Requires E2B_API_KEY in the environment; reads e2b.toml (pinned template_id → in-place update).
npx --yes @e2b/cli template build

curl -sf -o /dev/null https://vibehard-platform.fly.dev/api/auth-config && echo "release: health ok"
echo "release: platform + worker template published from $(cat .build-sha)"
