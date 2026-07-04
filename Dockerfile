# VibeHard platform web server (backlog #deploy1). Runs web/server.ts on Bun.
# Durable state (EPIC #33) expects DATABASE_URL to be set at runtime — without it, the server
# falls back to embedded pglite under ~/.vibehard/db, which is wiped on every restart of this
# container (no volume is mounted here). Secrets (VIBEHARD_SECRETS_KEY, VIBEHARD_SENTINEL_SECRET,
# etc.) are injected as runtime env — never baked into the image.
#
# flyctl, copied in below: the base image has neither Node/npm nor a `fly` binary, but the
# server's OWN pipeline shells out to both — `npx tsc` in the auto-fix loop (src/autofix/fixer.ts)
# and `fly machine run`/`apps create|destroy` for the container AND node/build verify-gate sandboxes
# (src/substrate/fly.ts, fly-exec-sandbox.ts). Found live 2026-07-04: a build's fix loop finally ran
# long enough to reach these code paths and hit "Executable not found in $PATH: npx/npm/fly" — this
# had been silently unreachable (and so unnoticed) in every earlier build that failed for some other
# reason first. `fly ssh console` on the live machine confirmed only `bun` exists on PATH.
FROM flyio/flyctl:latest AS flyctl
FROM oven/bun:1

WORKDIR /app

# Node.js (bundles npm + npx) — NodeSource's setup script for a modern LTS on Debian; the base
# image's own OS release (Debian 13 "trixie", confirmed via `fly ssh console`) has no nodejs
# package current enough for what generated apps (Next.js 14/15) expect.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# The flyctl image ships the binary at /flyctl; expose it under BOTH names since the codebase's
# own Fly runners default to `flyBin ?? ["fly"]`.
COPY --from=flyctl /flyctl /usr/local/bin/flyctl
RUN ln -s /usr/local/bin/flyctl /usr/local/bin/fly

# Install deps first (better layer caching): only re-runs when package.json/bun.lock change.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["bun", "run", "start"]
