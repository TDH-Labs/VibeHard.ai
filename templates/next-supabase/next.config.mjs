/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output: `next build` emits .next/standalone/server.js — a self-contained
  // node server that honors PORT/HOSTNAME at runtime (the platform's port contract).
  output: "standalone",
  // Pin the tracing root to THIS app. Next ≥15.5 walks up looking for a workspace lockfile
  // and, when it finds one (e.g. building inside a monorepo or CI checkout), NESTS the
  // standalone tree under the inferred workspace path — so `node .next/standalone/server.js`
  // stops existing. Pinning makes the output layout identical in the container, in CI, and
  // in a bare workspace.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
