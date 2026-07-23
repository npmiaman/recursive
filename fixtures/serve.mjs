import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tiny static server for the demo site, so the probe has something deliberately
 * broken to measure. Not part of the product — it exists so `npm run cli -- score`
 * can be verified without pointing at a real deployment.
 */

const ROOT = resolve(fileURLToPath(new URL("./site", import.meta.url)));
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    // Contain the path inside ROOT — this server is local-only, but a traversal
    // bug here would happily serve the rest of the disk.
    let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (!extname(path)) path = join(path, "index.html");

    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/html" }).end("<h1>404</h1>");
  }
}).listen(PORT, () => {
  console.log(`demo site on http://localhost:${PORT}`);
});
