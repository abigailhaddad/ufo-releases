/**
 * Serve the static export in out/ the way a static host does.
 *
 * `next start` refuses to run under `output: "export"`, so this stands in for
 * it in the Playwright webServer and for local spot-checks. It mirrors the
 * bits of Cloudflare Pages' behaviour the site depends on:
 *   - trailingSlash: true      -> /mirror/ serves out/mirror/index.html
 *   - /foo redirects to /foo/
 *   - unknown paths get 404 (no SPA rewrite -- this is a static export)
 *
 * Usage: tsx scripts/serve-out.ts [port] [dir]
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 3100);
const ROOT = path.resolve(process.cwd(), process.argv[3] ?? "out");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const decoded = decodeURIComponent(url.pathname);
  // Contain everything under ROOT -- no ../ escapes.
  const target = path.join(ROOT, path.normalize(decoded).replace(/^(\.\.[/\\])+/, ""));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  let file = target;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, "index.html");
  } else if (!fs.existsSync(file) && fs.existsSync(`${file}/index.html`)) {
    // trailingSlash: true -- /mirror -> /mirror/
    res.writeHead(308, { Location: `${decoded}/${url.search}` }).end();
    return;
  }

  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }

  res.writeHead(200, {
    "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": fs.statSync(file).size,
    "cache-control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`serving ${path.relative(process.cwd(), ROOT)} on http://localhost:${PORT}`);
});
