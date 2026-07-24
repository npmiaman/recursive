import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { verifyBackend } from "../src/sweep/backend.ts";

/**
 * Backend verification, end to end, with the REAL server SDK.
 *
 * The gap this closes: everything else proves a lying UI is caught by a
 * postcondition (the order count did not move). This proves the OTHER axis, a
 * lying BACKEND: the screen looks fine, the flow "passed", but the server threw
 * a 500. Recursive's server SDK records that in its trace ring, and
 * verifyBackend reads the real `/__recursive/trace` endpoint and flags it.
 *
 * No mocks: a real HTTP app mounts the actual server SDK middleware, real
 * requests hit it, and the real verifyBackend collects the real trace.
 *
 * Run: node --experimental-strip-types test/backend-verify.test.ts
 */

const require = createRequire(import.meta.url);
const { recursiveMiddleware } = require("../packages/server-sdk/recursive-server.js") as {
  recursiveMiddleware: (opts: { token?: string }) => (req: unknown, res: unknown, next: () => void) => void;
};

const PORT = 4597;
const TOKEN = "trace-secret";
const TRACE_URL = `http://localhost:${PORT}/__recursive/trace`;

// A tiny app instrumented with the real SDK. /api/orders LIES: it 500s, but a
// caller (or an optimistic UI) could still show success.
const mw = recursiveMiddleware({ token: TOKEN });
const app: Server = createServer((req, res) => {
  mw(req as never, res as never, () => {
    if (req.url?.startsWith("/api/orders")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"orders insert failed: column \\"currency\\" does not exist"}');
      return;
    }
    if (req.url?.startsWith("/api/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>ok</h1>");
  });
});

await new Promise<void>((r) => app.listen(PORT, r));

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`✓ ${name}`);
  else {
    failures++;
    console.error(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
  }
};

const hit = (path: string) => fetch(`http://localhost:${PORT}${path}`, { method: "POST" }).catch(() => {});

try {
  // ---- Scenario A: a genuinely clean run ----
  {
    const since = new Date().toISOString();
    await hit("/api/health");
    await new Promise((r) => setTimeout(r, 150)); // let res.finish record
    const result = await verifyBackend({ flowId: "clean-flow", traceUrl: TRACE_URL, token: TOKEN, since, uiPassed: true });
    check("trace endpoint is reachable (server SDK mounted)", result.available, JSON.stringify(result));
    check("a clean run passes backend verification", result.available && !result.failed, JSON.stringify(result.findings));
  }

  // ---- Scenario B: the UI "passed" but the backend 500'd ----
  {
    const since = new Date().toISOString();
    await hit("/api/orders"); // 500
    await new Promise((r) => setTimeout(r, 150));
    // uiPassed: true is the whole point, the screen said success.
    const result = await verifyBackend({ flowId: "checkout", traceUrl: TRACE_URL, token: TOKEN, since, uiPassed: true });

    check("the lying backend is caught even though the UI passed", result.failed, JSON.stringify(result.findings));
    check(
      "the finding names the real server error",
      result.findings.some((f) => f.severity === "failure" && /server error/i.test(f.title)),
      result.findings.map((f) => f.title).join("; "),
    );
    check(
      "the trace carries the concrete evidence for repair",
      result.findings.some((f) => f.evidence?.includes("500")),
      "no 500 in evidence",
    );
  }

  // ---- Scenario C: the token actually gates the trace ----
  {
    const since = new Date().toISOString();
    const wrong = await verifyBackend({ flowId: "x", traceUrl: TRACE_URL, token: "WRONG", since, uiPassed: true });
    // A rejected trace is "unavailable", never a false pass or a crash.
    check("a wrong trace token yields unavailable, not a false pass", !wrong.available && !wrong.failed);
  }
} finally {
  app.close();
}

console.log(failures === 0 ? "\nall backend-verify checks passed" : `\n${failures} check(s) failed`);
if (failures > 0) process.exitCode = 1;
