import { createServer } from "node:http";

/**
 * Recursive model proxy.
 *
 * Holds ONE model key server-side and forwards OpenAI-compatible requests to the
 * upstream provider. The point: a laptop running Recursive sets its base URL to
 * this proxy and needs no API key of its own. The key lives here, in one place,
 * so you rotate it once and every machine keeps working, and it never travels
 * with the code or sits on anyone's laptop.
 *
 * Deploy this anywhere that runs Node (Railway, Render, Fly, a VPS) or adapt the
 * handler to a Vercel/Cloudflare function. Set two env vars:
 *
 *   NVIDIA_API_KEY   the real nvapi-... key (or any upstream key)   [required]
 *   PROXY_TOKEN      a shared secret laptops must present            [recommended]
 *
 * PROXY_TOKEN is what stops the open internet from using your key. It is NOT the
 * upstream key: it only grants access to this proxy, and you can rotate it
 * without touching the real key. Leave it unset only for a proxy on a private
 * network.
 *
 * The upstream key's own limit still applies. On NVIDIA's free tier that is 40
 * requests/min TOTAL across every laptop pointed here, which is fine for a
 * handful of machines testing, and the reason to move to a paid key for launch.
 */

const KEY = process.env.NVIDIA_API_KEY;
const TOKEN = process.env.PROXY_TOKEN;
const UPSTREAM = (process.env.UPSTREAM_BASE || "https://integrate.api.nvidia.com").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 8787);

if (!KEY) {
  console.error("NVIDIA_API_KEY is not set. The proxy has no key to forward with.");
  process.exit(1);
}

createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    // A laptop authorises with the shared token, never with the real key.
    if (TOKEN) {
      const auth = req.headers["authorization"] ?? "";
      if (auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end('{"error":"unauthorized: set the proxy token with `recursive config proxy <url> <token>`"}');
        return;
      }
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // Forward the path as-is (e.g. /v1/chat/completions), swapping in the real
    // key. The laptop's Authorization header (the proxy token) is dropped.
    const upstream = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(buffer);
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy failed", detail: String(error) }));
  }
}).listen(PORT, () => {
  console.log(
    `recursive model proxy on :${PORT} -> ${UPSTREAM} ${TOKEN ? "(token required)" : "(OPEN, set PROXY_TOKEN)"}`,
  );
});
