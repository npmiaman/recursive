import { createServer, type Server } from "node:http";
import { z } from "zod";
import { OpenAICompatibleProvider } from "../src/llm/provider.ts";

/**
 * Proves the NVIDIA free-tier path works WITHOUT a real key.
 *
 * A hosted free tier (build.nvidia.com is 40 RPM) fails a naive client two ways:
 * the client fires faster than the cap and gets 429'd, and when it is 429'd it
 * does not know to wait and retry. This test stands up a mock endpoint that
 * behaves like a rate-limited one and checks both fixes:
 *
 *   1. PACING   requests are spaced so the endpoint never sees a burst over cap
 *   2. BACKOFF  a 429 with Retry-After is honoured and the request succeeds
 *
 * Everything here is local: a fake OpenAI-compatible server, no network, no key.
 * Run: node --experimental-strip-types test/ratelimit.test.ts
 */

const PORT = 4591;

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`✓ ${name}`);
  else {
    failures++;
    console.error(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
  }
};

// ---- a mock rate-limited NIM ---------------------------------------------
//
// Records the arrival time of every /chat/completions call, and can be told to
// 429 the first N calls (with Retry-After) to exercise the backoff path.
const arrivals: number[] = [];
let force429ForFirst = 0;
let calls = 0;

const server: Server = createServer((req, res) => {
  if (req.url === "/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"data":[]}');
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls++;
    if (calls <= force429ForFirst) {
      // Exactly what NVIDIA sends when you exceed the tier: 429 + Retry-After.
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      res.end('{"error":"rate limit exceeded"}');
      return;
    }
    arrivals.push(Date.now());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }));
  });
});

await new Promise<void>((r) => server.listen(PORT, r));

// Point the provider at the mock, as `.env` would for the real NVIDIA endpoint.
process.env["LLM_PROVIDER"] = "openai";
process.env["OPENAI_BASE_URL"] = `http://localhost:${PORT}`;
process.env["OPENAI_API_KEY"] = "nvapi-fake-for-test";

const Schema = z.object({ ok: z.boolean() });

try {
  // ---- 1. PACING -----------------------------------------------------------
  //
  // 120 RPM => 500ms spacing. Fire 5 concurrent calls and confirm the endpoint
  // saw them spaced, not all at once. 120 rather than 40 keeps the test fast
  // while exercising the identical code path.
  {
    process.env["OPENAI_RPM"] = "120";
    const provider = new OpenAICompatibleProvider({
      baseUrl: `http://localhost:${PORT}`,
      model: "mock",
      apiKey: "nvapi-fake-for-test",
      rpm: 120,
    });

    arrivals.length = 0;
    force429ForFirst = 0;
    calls = 0;

    const started = Date.now();
    await Promise.all(Array.from({ length: 5 }, () => provider.structured(Schema, "go")));
    const elapsed = Date.now() - started;

    check("all 5 paced requests completed", arrivals.length === 5, `got ${arrivals.length}`);

    // 5 starts at 500ms spacing => the 5th starts ~2000ms in. Allow slack for
    // timer coarseness, but it must be clearly more than "all at once".
    check(
      "requests were spaced, not bursted",
      elapsed >= 1800,
      `elapsed ${elapsed}ms (expected >= ~2000ms for 5 @ 120 RPM)`,
    );

    const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]!);
    const minGap = Math.min(...gaps);
    check(
      "no two requests arrived closer than the cap allows",
      minGap >= 400,
      `smallest gap ${minGap}ms (interval is 500ms)`,
    );
  }

  // ---- 2. BACKOFF ----------------------------------------------------------
  //
  // The endpoint 429s the first two attempts with Retry-After: 1. The request
  // must wait and retry rather than throwing, and ultimately succeed.
  {
    const provider = new OpenAICompatibleProvider({
      baseUrl: `http://localhost:${PORT}`,
      model: "mock",
      apiKey: "nvapi-fake-for-test",
      rpm: 0, // pacing off, so this measures backoff alone
      maxRetries: 4,
    });

    arrivals.length = 0;
    force429ForFirst = 2;
    calls = 0;

    const started = Date.now();
    const result = await provider.structured(Schema, "go");
    const elapsed = Date.now() - started;

    check("a 429'd request eventually succeeds", result.ok === true);
    check("it retried past the two 429s", calls === 3, `made ${calls} attempts`);
    check(
      "it honoured Retry-After (~1s x2), not an instant retry",
      elapsed >= 1800,
      `elapsed ${elapsed}ms (expected >= ~2000ms for two 1s waits)`,
    );
  }

  // ---- 3. a non-retryable error fails fast ---------------------------------
  {
    const provider = new OpenAICompatibleProvider({
      baseUrl: `http://localhost:${PORT}`,
      model: "mock",
      apiKey: "nvapi-fake-for-test",
      maxRetries: 4,
    });

    // 999 forces the mock to 429 forever; but we want to prove a 401-style
    // error is NOT retried. Simulate by pointing at a dead port.
    const deadProvider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:1",
      model: "mock",
      apiKey: "x",
    });
    void provider;

    let threw = false;
    const started = Date.now();
    try {
      await deadProvider.structured(Schema, "go");
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - started;
    // A connection refusal is not a 429/5xx HTTP status, so withRetry rethrows
    // it immediately rather than backing off four times.
    check("a connection error is not retried with backoff", threw && elapsed < 1500, `elapsed ${elapsed}ms`);
  }
} finally {
  server.close();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
if (failures > 0) process.exitCode = 1;
