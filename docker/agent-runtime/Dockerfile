# The hosted-agent runtime image (AHP-4): buzz-acp + buzz-cli + goose on one small
# Debian base, driven by entrypoint.sh (which unpacks the persona pack from env and
# supervises one buzz-acp process per agent identity — see src/agent-hosting/machines.ts
# for the env contract: AGENTS_JSON, PACK_FILES_B64, AGENT_KEY_*).
#
# Pinning: BUZZ_REF pins the exact block/buzz commit the binaries are built from —
# bump deliberately, never `main` (same discipline as the platform's own pinned gate
# containers). goose installs from Block's release channel at a pinned version.

FROM rust:1.95-slim-bookworm AS buzz-build
ARG BUZZ_REF=main
RUN apt-get update && apt-get install -y --no-install-recommends git pkg-config libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/block/buzz.git /src && cd /src && git checkout ${BUZZ_REF}
WORKDIR /src
RUN cargo build --release -p buzz-acp -p buzz-cli

FROM debian:bookworm-slim
ARG GOOSE_VERSION=v1.36.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 libxcb1 nodejs npm && rm -rf /var/lib/apt/lists/*
# goose CLI from Block's pinned release (CONFIGURE=false → no interactive setup;
# config comes entirely from buzz-acp-injected env vars per CONTRACTS.md).
RUN curl -fsSL https://github.com/block/goose/releases/download/${GOOSE_VERSION}/download_cli.sh | CONFIGURE=false GOOSE_BIN_DIR=/usr/local/bin bash
COPY --from=buzz-build /src/target/release/buzz-acp /usr/local/bin/buzz-acp
COPY --from=buzz-build /src/target/release/buzz /usr/local/bin/buzz
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && useradd -m -u 10001 agent
USER agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
