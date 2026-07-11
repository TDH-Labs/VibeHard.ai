# E2B build-worker template (docs/build-substrate/{SPEC,PRD,ARCHITECTURE}.md, W3). Same runtime
# surface as the platform's own Dockerfile (bun, node22, flyctl/fly, semgrep/gitleaks/trivy) so
# `bun src/cli.ts build/fix/ship <dir>` behaves identically to how it runs on-host today — the
# whole point of this workstream is that the PIPELINE doesn't change, only where it runs.
#
# Single-stage, unlike the platform Dockerfile: E2B's template builder does not support
# multi-stage Dockerfiles (confirmed live 2026-07-11 — `template create` fails outright with
# "Multi-stage Dockerfiles are not supported" against the platform Dockerfile's
# `FROM flyio/flyctl:latest AS flyctl` / `COPY --from=flyctl` pattern). flyctl is installed here
# via its own official install script instead of copied from a second build stage — same end
# result (a `flyctl`/`fly` binary on PATH), single stage.
FROM oven/bun:1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 python3-pip python3-setuptools zip \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN curl -L https://fly.io/install.sh | sh \
  && mv "$HOME/.fly/bin/flyctl" /usr/local/bin/flyctl \
  && ln -s /usr/local/bin/flyctl /usr/local/bin/fly

# Security scanner gates — versions must match sast.ts/secrets.ts/depvuln.ts's
# SEMGREP_VERSION/GITLEAKS_VERSION/TRIVY_VERSION constants, same as the platform Dockerfile.
RUN pip3 install --no-cache-dir --break-system-packages "semgrep==1.96.0"
RUN curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz" \
  | tar xz -C /usr/local/bin gitleaks
RUN curl -fsSL "https://github.com/aquasecurity/trivy/releases/download/v0.72.0/trivy_0.72.0_Linux-64bit.tar.gz" \
  | tar xz -C /usr/local/bin trivy

# Single COPY (no split package.json-first layer-caching trick, unlike the platform Dockerfile):
# this template is built once, not on every CI run, so the caching optimization buys nothing —
# and E2B's COPY doesn't auto-create a destination directory the way Docker's does, which made
# `COPY packages/gate-check/package.json packages/gate-check/` fail outright ("failed to move
# files in sandbox") when that directory didn't exist yet. Copying everything at once sidesteps
# it: every destination directory already exists by the time COPY runs.
COPY . .
RUN bun install --frozen-lockfile --production

ENV NODE_ENV=production
