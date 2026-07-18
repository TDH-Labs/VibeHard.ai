# Static Next.js app: build the export, serve out/ with server.js.
# THE PORT CONTRACT: the platform routes traffic to internal port 8080 and injects PORT at
# runtime; server.js reads process.env.PORT (default 8080). Never pin ENV PORT here.
FROM node:22-alpine

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

WORKDIR /app
RUN chown nextjs:nodejs /app
USER nextjs

COPY --chown=nextjs:nodejs package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY --chown=nextjs:nodejs . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
