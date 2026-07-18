/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output: `next build` emits .next/standalone/server.js — a self-contained
  // node server that honors PORT/HOSTNAME at runtime (the platform's port contract).
  output: "standalone",
};

export default nextConfig;
