/**
 * Static file server for the exported site (out/). This is the container's entry point.
 *
 * THE PORT CONTRACT: the platform routes traffic to the container's internal port and
 * injects PORT at runtime — this server listens on process.env.PORT, defaulting to 8080
 * (the platform's convention). Never hard-code a different port here.
 */
const { createServer } = require("node:http");
const { createReadStream, existsSync, statSync } = require("node:fs");
const { join, extname, normalize } = require("node:path");

const OUT_DIR = join(__dirname, "out");
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

if (!existsSync(OUT_DIR)) {
  console.error("out/ not found - run `npm run build` first");
  process.exit(1);
}

/** Resolve a URL pathname to a file inside out/, or null. Traversal-safe: the
 *  normalized path must stay under out/. Extensionless routes fall back to
 *  <path>.html, <path>/index.html, then the SPA root index.html. */
function resolveFile(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const base = join(OUT_DIR, rel);
  if (!base.startsWith(OUT_DIR)) return null;
  const candidates = pathname.endsWith("/")
    ? [join(base, "index.html")]
    : extname(base)
      ? [base]
      : [base + ".html", join(base, "index.html")];
  candidates.push(join(OUT_DIR, "index.html"));
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }
  const file = resolveFile(pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
  const stream = createReadStream(file);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
  });
  stream.pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log("serving out/ on port " + String(PORT));
});

// Graceful shutdown: exit promptly on SIGTERM so a deploy restart never has to force-kill us.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
