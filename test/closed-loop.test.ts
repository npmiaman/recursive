import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end test of the closed repair loop, with no API key and no cloud.
 *
 * This is the test the loop most needed, because every part of it was written
 * but never executed together. It exercises the real spine:
 *
 * verify the flow in a real browser  → it fails
 * ask the debugger what to do        →  (stub model)
 * apply a change to a real file      → the page is genuinely rewritten
 * verify AGAIN in a real browser     → it passes
 * check the server postcondition     → the order count really moved
 *
 * The page is broken the way real pages break: the Place Order button has a
 * click handler that throws before it ever calls the API, so the UI looks fine
 * and nothing is recorded. That is the exact class of failure, a UI that lies,
 * which the postcondition check exists to catch.
 *
 * Two model calls are stubbed via an OpenAI-compatible local server. Everything
 * else is real: real Chromium, real HTTP, real file writes.
 *
 * Run: node --experimental-strip-types test/closed-loop.test.ts
 */

const PORT = 4599;
const LLM_PORT = 4598;

let orderCount = 0;
/** Flipped by applyChange, this IS the bug and the fix. */
let buttonIsBroken = true;

const root = mkdtempSync(join(tmpdir(), "recursive-loop-"));
const pageFile = join(root, "page.html");

function renderPage(broken: boolean): string {
  return `<!doctype html><html><body>
<h1>Checkout</h1>
<button id="place">Place Order</button>
<p id="status"></p>
<script>
document.getElementById('place').addEventListener('click', async () => {
  ${
    broken
      ? // The bug: a typo'd reference throws before fetch is ever reached. The
        // status text still updates because it runs in the catch, so the screen
        // says "Order placed!" while the server has heard nothing at all.
        `try { cart.total.toFixed(2); } catch (e) {}
 document.getElementById('status').textContent = 'Order placed!';`
      : `await fetch('/api/orders', { method: 'POST' });
 document.getElementById('status').textContent = 'Order placed!';`
  }
});
</script></body></html>`;
}

writeFileSync(pageFile, renderPage(true));

// ---- the app under test --------------------------------------------------
const app: Server = createServer((req, res) => {
  if (req.url === "/api/orders" && req.method === "POST") {
    orderCount++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url?.startsWith("/api/test/orders/count")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ count: orderCount }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(readFileSync(pageFile, "utf8"));
});

// ---- the stub model ------------------------------------------------------
//
// Two callers share this endpoint and they want different schemas, so it
// dispatches on the prompt: the browsing agent asks "What is your next
// action?", everything else is the debugger.
//
// Both replies are scripted rather than reasoned. That is deliberate, it makes
// the run deterministic, so any failure of this test is a real regression in
// the loop and never a model having an off day.
let diagnoseCalls = 0;
let browseCalls = 0;

/**
 * A three-line browsing policy: click Place Order, then confirm.
 *
 * Driven off the rendered element list rather than a fixed step count, so it
 * still behaves correctly if the agent needs an extra observation.
 */
function browseDecision(prompt: string): Record<string, unknown> {
  if (/Order placed!/i.test(prompt)) {
    return {
      thought: "The confirmation is on screen.",
      action: "done",
      reason: "Order placed! is shown.",
    };
  }
  const match = prompt.match(/\[(\d+)\][^\n]*Place Order/i);
  if (!match) {
    return {
      thought: "No Place Order control is present.",
      action: "fail",
      reason: "button missing",
    };
  }
  return { thought: "Placing the order.", action: "click", index: Number(match[1]) };
}

const llm: Server = createServer((req, res) => {
  if (req.url === "/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"data":[]}');
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const prompt = (JSON.parse(body).messages ?? [])
      .map((m: { content: string }) => m.content)
      .join("\n");

    if (/What is your next action\?/.test(prompt)) {
      browseCalls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(browseDecision(prompt)) } }],
        }),
      );
      return;
    }

    diagnoseCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                whyPreviousAttemptFailed:
                  diagnoseCalls === 1
                    ? "No attempt has been made yet."
                    : "The handler still threw before reaching the network call.",
                revisedHypothesis:
                  "The click handler throws on an undefined reference before it calls the orders API, so nothing is ever submitted.",
                hypothesisChanged: true,
                nextApproach: {
                  title: "Make the click handler actually call the orders API",
                  rationale: "The server never receives a request, so the failure is client-side.",
                  approach: "Remove the throwing reference and POST to /api/orders.",
                  risk: "low",
                },
                needsHuman: false,
                missingEvidence: [],
              }),
            },
          },
        ],
      }),
    );
  });
});

await new Promise<void>((r) => app.listen(PORT, r));
await new Promise<void>((r) => llm.listen(LLM_PORT, r));

process.env["LLM_PROVIDER"] = "openai";
process.env["OPENAI_BASE_URL"] = `http://localhost:${LLM_PORT}`;
process.env["OPENAI_API_KEY"] = "stub";
process.env["OPENAI_MODEL"] = "stub";

// Imported AFTER the env is set, because the provider resolves config on load.
const { runClosedLoop } = await import("../src/loop/closed.ts");
const { append } = await import("../src/memory/store.ts");

const PROJECT = "closed-loop-test";

const flow = {
  id: "checkout",
  name: "Customer can place an order",
  critical: true,
  url: "/",
  goal: "Click the Place Order button to place an order.",
  expect: "The page confirms the order was placed.",
  touches: ["page.html"],
  maxSteps: 8,
  // The assertion that catches the lying UI: the screen saying "Order placed!"
  // is not evidence; the count going up is.
  verify: [
    {
      name: "an order was really created",
      kind: "count-delta" as const,
      url: `http://localhost:${PORT}/api/test/orders/count`,
      countPath: "count",
      expectDelta: 1,
    },
  ],
};

const manifest = { baseUrl: `http://localhost:${PORT}`, flows: [flow] };

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`✓ ${name}`);
  else {
    failures++;
    console.error(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
  }
};

try {
  const failure = {
    type: "failure" as const,
    id: "f1",
    projectId: PROJECT,
    at: new Date().toISOString(),
    fingerprint: "flow:checkout@/",
    signalClass: "flow-failure",
    route: "/",
    message: "Place Order appears to succeed but no order is created.",
    implicatedFiles: ["page.html"],
  };
  append(failure);

  const appliedCycles: number[] = [];

  const result = await runClosedLoop({
    projectId: PROJECT,
    flow,
    manifest,
    failure,
    maxCycles: 3,
    headless: true,
    onProgress: (l) => console.log(`    ${l.trim()}`),
    applyChange: async (_diagnosis, cycle) => {
      appliedCycles.push(cycle);
      // The real repair: rewrite the page so the handler reaches the API.
      buttonIsBroken = false;
      writeFileSync(pageFile, renderPage(false));
      return { applied: true, summary: "Rewrote the click handler.", filesChanged: ["page.html"] };
    },
    revertChange: async () => {
      buttonIsBroken = true;
      writeFileSync(pageFile, renderPage(true));
    },
  });

  console.log();
  check("loop reports the flow as resolved", result.resolved, `stopped: ${result.stoppedBecause}`);
  check(
    "it stopped because it VERIFIED, not because it ran out of budget",
    result.stoppedBecause === "verified",
    `stoppedBecause = ${result.stoppedBecause}`,
  );
  check("it took exactly one cycle", appliedCycles.length === 1, `cycles: ${appliedCycles}`);
  check("the page was actually repaired", !buttonIsBroken);

  // The heart of it. Cycle 0 confirmed broken, cycle 1 verified fixed, so the
  // journey ran at least twice in a real browser. A loop that "fixed" something
  // without re-driving the flow would show one run.
  check(
    "the user journey was re-driven after the change",
    result.cycles.length >= 1 && result.cycles[0]?.flowPassed === true,
    JSON.stringify(result.cycles.map((c) => ({ cycle: c.cycle, passed: c.flowPassed }))),
  );

  // The postcondition is what makes this trustworthy: a real order exists.
  check(
    "a real order reached the server (UI claim independently confirmed)",
    orderCount >= 1,
    `orderCount = ${orderCount}`,
  );

  console.log(
    `\n  ${diagnoseCalls} debug call(s), ${browseCalls} browse call(s); ${orderCount} order(s) actually created`,
  );
} finally {
  app.close();
  llm.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
if (failures > 0) process.exitCode = 1;
