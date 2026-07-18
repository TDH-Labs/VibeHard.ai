# Next.js (standalone) + Supabase app.
# THE PORT CONTRACT: the platform routes traffic to internal port 8080 and injects PORT at
# runtime; Next's standalone server honors PORT/HOSTNAME. The 8080 default below only covers
# a bare `docker run` with no PORT injected — never pin a DIFFERENT value.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Build-time env: public Supabase config may be inlined into the client bundle; the platform
# injects real values at deploy. Dummies here keep a bare `docker build` green.
ARG NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-placeholder
RUN npm run build

FROM node:22-alpine
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=8080

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
