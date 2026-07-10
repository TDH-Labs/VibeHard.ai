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
# zip — the base image ships `tar` (used above) but not `zip`; /api/export (web/server.ts) shells
# out to it to produce the downloadable-tool export archive, matching the codebase's existing
# preference for a native binary over an npm archiving dependency.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 python3-pip python3-setuptools zip \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# The flyctl image ships the binary at /flyctl; expose it under BOTH names since the codebase's
# own Fly runners default to `flyBin ?? ["fly"]`.
COPY --from=flyctl /flyctl /usr/local/bin/flyctl
RUN ln -s /usr/local/bin/flyctl /usr/local/bin/fly

# Security scanner gates (sast/secrets/depvuln) — NATIVE binaries, not Docker. Found live
# 2026-07-06: this base image never had `docker` (and never will — running Docker-in-Docker
# inside a Fly Firecracker microVM needs privileges this container doesn't have), so every
# build's sast/secrets/depvuln gate crash-blocked forever with "Executable not found in
# $PATH: docker" — a full-platform outage, since every build hits these gates. These three
# scanners only READ source as data (never execute the app's code), so running them on-host
# is exactly as safe as any other static text scan — see src/substrate/fly-sandbox.ts's own
# header, which already documents that boundary. Versions match sast.ts/secrets.ts/depvuln.ts's
# SEMGREP_VERSION/GITLEAKS_VERSION/TRIVY_VERSION constants — keep these in sync.
RUN pip3 install --no-cache-dir --break-system-packages "semgrep==1.96.0"
RUN curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz" \
  | tar xz -C /usr/local/bin gitleaks
RUN curl -fsSL "https://github.com/aquasecurity/trivy/releases/download/v0.72.0/trivy_0.72.0_Linux-64bit.tar.gz" \
  | tar xz -C /usr/local/bin trivy

# Install deps first (better layer caching): only re-runs when package.json/bun.lock change.
# The workspace packages' own manifests must be present before install — `bun install
# --frozen-lockfile` resolves "workspace:*" deps by reading packages/*/package.json, and fails
# outright ("Workspace dependency not found") if only the root manifest has been copied in yet.
COPY package.json bun.lock ./
COPY packages/gate-check/package.json packages/gate-check/
COPY packages/orchestrator/package.json packages/orchestrator/
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["bun", "run", "start"]
