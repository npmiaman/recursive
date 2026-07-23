import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import type { Project } from "../tenant.ts";
import { appendSignals } from "./store.ts";
import { fingerprint, type Signal } from "./types.ts";

/**
 * Synthetic journey checks.
 *
 * The only detector that works with **no live traffic**, at 3am, on a
 * low-volume tenant, or in the minutes after a deploy before any real user has
 * hit the new code. It's the difference between finding out you broke checkout
 * from your monitoring versus from a customer email on Monday.
 *
 * A journey is a short scripted path through the critical flow. It fails loudly
 * if a step can't be completed, and that failure becomes a signal in exactly the
 * same shape as one reported by a real browser.
 */

export interface JourneyStep {
  /** Human-readable, used in the failure message. */
  name: string;
  /** Path relative to the project's baseUrl. */
  goto?: string;
  /** Click this selector. */
  click?: string;
  /** Fill this selector with this value. */
  fill?: { selector: string; value: string };
  /** Assert this selector appears within the timeout. */
  expect?: string;
  /** Assert the URL contains this fragment after the step. */
  expectUrl?: string;
  timeoutMs?: number;
}

export interface Journey {
  name: string;
  /** Steps run in order; the first failure fails the journey. */
  steps: JourneyStep[];
  /** Skip this journey unless the project is in these environments. */
  environments?: Project["environment"][];
}

export interface JourneyResult {
  journey: string;
  ok: boolean;
  failedStep?: string;
  reason?: string;
  durationMs: number;
  /** Console errors seen during the run, often the actual cause. */
  consoleErrors: string[];
}

/**
 * The default journey for any web project: can a user load the homepage and see
 * something? Deliberately minimal, real journeys are project-specific and are
 * defined by the customer.
 */
export const DEFAULT_JOURNEYS: Journey[] = [
  {
    name: "homepage-loads",
    steps: [
      { name: "open homepage", goto: "/", timeoutMs: 15_000 },
      { name: "page has content", expect: "body" },
    ],
  },
];

async function runStep(page: Page, step: JourneyStep, baseUrl: string): Promise<void> {
  const timeout = step.timeoutMs ?? 10_000;

  if (step.goto !== undefined) {
    const url = new URL(step.goto, baseUrl).toString();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    if (response && response.status() >= 400) {
      throw new Error(`HTTP ${response.status()} loading ${step.goto}`);
    }
  }
  if (step.fill) {
    await page.locator(step.fill.selector).first().fill(step.fill.value, { timeout });
  }
  if (step.click) {
    await page.locator(step.click).first().click({ timeout });
  }
  if (step.expect) {
    await page.locator(step.expect).first().waitFor({ state: "visible", timeout });
  }
  if (step.expectUrl) {
    await page.waitForURL((url) => url.toString().includes(step.expectUrl!), { timeout });
  }
}

export async function runJourney(
  browser: Browser,
  journey: Journey,
  baseUrl: string,
): Promise<JourneyResult> {
  const started = Date.now();
  const consoleErrors: string[] = [];

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });
  const page = await context.newPage();

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 500));
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 500)));

  try {
    for (const step of journey.steps) {
      try {
        await runStep(page, step, baseUrl);
      } catch (error) {
        return {
          journey: journey.name,
          ok: false,
          failedStep: step.name,
          reason: error instanceof Error ? error.message.split("\n")[0] : String(error),
          durationMs: Date.now() - started,
          consoleErrors,
        };
      }
    }
    return { journey: journey.name, ok: true, durationMs: Date.now() - started, consoleErrors };
  } finally {
    await context.close();
  }
}

export interface HealthRunResult {
  results: JourneyResult[];
  signals: Signal[];
}

/**
 * Run every journey for a project and convert failures into signals.
 * The signals are indistinguishable downstream from SDK-reported ones, so
 * correlation and Tier 0 work identically whether a human hit the bug or we did.
 */
export async function runHealthChecks(
  project: Project,
  journeys: Journey[] = DEFAULT_JOURNEYS,
  release?: string,
): Promise<HealthRunResult> {
  const applicable = journeys.filter(
    (j) => !j.environments || j.environments.includes(project.environment),
  );

  const browser = await chromium.launch({ headless: true });
  const results: JourneyResult[] = [];

  try {
    for (const journey of applicable) {
      results.push(await runJourney(browser, journey, project.baseUrl));
    }
  } finally {
    await browser.close();
  }

  const now = new Date().toISOString();
  const signals: Signal[] = results
    .filter((result) => !result.ok)
    .map((result) => {
      const message =
        `Journey '${result.journey}' failed at step '${result.failedStep}': ${result.reason}` +
        (result.consoleErrors.length ? ` | console: ${result.consoleErrors[0]}` : "");
      const route = `/journey/${result.journey}`;
      return {
        id: randomUUID(),
        projectId: project.id,
        class: "health-check-failed" as const,
        source: "synthetic" as const,
        at: now,
        route,
        release,
        cohort: {},
        fingerprint: fingerprint({ class: "health-check-failed", route, message }),
        message,
        count: 1,
        // A synthetic failure is evidence that EVERY session on this path is
        // affected, so it clears the min-sessions floor on its own. Without this
        // a real outage detected before any user arrives would be filtered as noise.
        sessions: 10,
      };
    });

  if (signals.length) appendSignals(project.id, signals);
  return { results, signals };
}
