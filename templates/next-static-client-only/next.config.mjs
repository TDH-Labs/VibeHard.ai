/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: `next build` writes the deployable site to out/ — served by server.js
  // in the container. No server-side rendering, no API routes, no backend.
  output: "export",
};

export default nextConfig;
