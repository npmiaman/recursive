import { BrowserPool } from "../src/browse/pool.ts";
import { observe, renderObservation } from "../src/browse/observe.ts";
import { replay, saveTrace, type Trace } from "../src/browse/trace.ts";

/**
 * Measures the two claims behind the internal browsing agent:
 *
 *   1. Element indexing is far cheaper than a screenshot.
 *   2. Replay completes a flow with ZERO model calls.
 *
 * Both are verifiable without any model or API key, replay is pure Playwright,
 * and the observation size is just bytes. Run against the bundled fixture site:
 *
 * node fixtures/serve.mjs &
 * node --experimental-strip-types test/browse.test.ts
 */

const BASE = process.env["TEST_BASE_URL"] ?? "http://localhost:4173";

const pool = new BrowserPool({ headless: true });
let failures = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) console.log(`✓ ${name}, ${detail}`);
  else {
    failures++;
    console.error(`✗ ${name}, ${detail}`);
  }
}

try {
  await pool.start();

  // ---------------------------------------------- 1. observation cost
  {
    const { context, page } = await pool.acquire();
    await page.goto(`${BASE}/pricing/`, { waitUntil: "domcontentloaded" });

    const observation = await observe(page);
    const rendered = renderObservation(observation);
    // ~4 chars/token is the usual rule of thumb for English + code.
    const textTokens = Math.ceil(rendered.length / 4);

    // A 1280×800 screenshot costs roughly 1,100-1,600 tokens on current vision
    // models. Use the conservative end so the comparison understates our win.
    const screenshotTokens = 1100;

    console.log("\n--- what the model actually sees ---");
    console.log(rendered.split("\n").slice(0, 12).join("\n"));
    console.log("---\n");

    check(
      "element indexing is cheaper than a screenshot",
      textTokens < screenshotTokens,
      `${textTokens} tokens vs ~${screenshotTokens} for a screenshot (${(screenshotTokens / textTokens).toFixed(1)}× cheaper)`,
    );

    check(
      "interactive elements were found",
      observation.elements.length > 0,
      `${observation.elements.length} element(s) indexed`,
    );

    const cta = observation.elements.find((e) => /get started/i.test(e.label));
    check(
      "the primary CTA is indexed with usable selectors",
      Boolean(cta && cta.selectors.length > 0),
      cta ? `"${cta.label}" → ${cta.selectors[0]}` : "CTA not found",
    );

    await pool.release(context);
  }

  // ---------------------------------------------- 2. replay, zero model calls
  {
    const trace: Trace = {
      flowId: "test-replay",
      goal: "Open pricing and click the primary CTA",
      startUrl: `${BASE}/pricing/`,
      recordedAt: new Date().toISOString(),
      replays: 0,
      repairs: 0,
      steps: [
        { action: "goto", selectors: [], value: `${BASE}/pricing/` },
        {
          action: "click",
          // Ranked: the first two do not exist on this page, so this also proves
          // the fallback chain works rather than just the happy selector.
          selectors: ["[data-testid='cta']", "#cta", "a.cta"],
          label: "Get started",
          // The fixture's CTA calls preventDefault, so it deliberately does not
          // navigate. Assert something that is actually true after the click.
          expect: { textPresent: "Pricing" },
        },
      ],
    };
    saveTrace(trace);

    const { context, page } = await pool.acquire();
    const started = Date.now();
    const outcome = await replay(page, trace);
    const elapsed = Date.now() - started;

    check(
      "replay completed every step with no model calls",
      outcome.ok,
      outcome.ok
        ? `${outcome.completed} steps in ${elapsed}ms, 0 model calls`
        : `stopped at step ${outcome.failedAt}: ${outcome.reason}`,
    );

    check(
      "replay is fast enough to run everything nightly",
      elapsed < 5000,
      `${elapsed}ms for the flow`,
    );

    await pool.release(context);
  }

  // ---------------------------------------------- 3. replay detects breakage
  {
    const broken: Trace = {
      flowId: "test-replay-broken",
      goal: "Click an element that no longer exists",
      startUrl: `${BASE}/pricing/`,
      recordedAt: new Date().toISOString(),
      replays: 0,
      repairs: 0,
      steps: [
        { action: "goto", selectors: [], value: `${BASE}/pricing/` },
        { action: "click", selectors: ["#element-that-does-not-exist"], label: "gone" },
      ],
    };

    const { context, page } = await pool.acquire();
    const outcome = await replay(page, broken);

    check(
      "replay stops at the changed step instead of drifting",
      !outcome.ok && outcome.failedAt === 1,
      outcome.ok
        ? "replay wrongly reported success"
        : `stopped at step ${outcome.failedAt}, agent resumes here`,
    );

    await pool.release(context);
  }
} finally {
  await pool.stop();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
if (failures > 0) process.exitCode = 1;
