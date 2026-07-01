# VibeHard platform web server (backlog #deploy1). Runs web/server.ts on Bun.
# Durable state (EPIC #33) expects DATABASE_URL to be set at runtime — without it, the server
# falls back to embedded pglite under ~/.vibehard/db, which is wiped on every restart of this
# container (no volume is mounted here). Secrets (VIBEHARD_SECRETS_KEY, VIBEHARD_SENTINEL_SECRET,
# etc.) are injected as runtime env — never baked into the image.
FROM oven/bun:1

WORKDIR /app

# Install deps first (better layer caching): only re-runs when package.json/bun.lock change.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["bun", "run", "start"]
