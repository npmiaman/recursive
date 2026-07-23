import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { config } from "../config.ts";
import { observe, type InteractiveElement } from "./observe.ts";

/**
 * Action traces and deterministic replay.
 *
 * THE KEY IDEA: a flow that succeeded once is a script. The expensive part,
 * working out what to click, has already been done. Replaying that sequence
 * costs zero model calls; only a page that has actually changed needs thinking.
 *
 * Today a sweep pays an LLM to rediscover "click Add to Cart, then Checkout,
 * then fill the card" every single night against a product that didn't change.
 *
 * Two design decisions make replay survive real codebases:
 *
 *  1. RANKED SELECTORS. Each step stores several ways to find the element, most
 * stable first. A class rename breaks the CSS selector but not the test id;
 * a DOM restructure breaks both but not role+name. Replay tries each in turn.
 *
 *  2. PER-STEP EXPECTATIONS. Every step records what it believed would happen.
 *     Replay asserts it. Without this, replay silently drifts, clicking things
 * that happen to match while the flow goes somewhere else entirely, and
 * reporting success.
 *
 * When replay fails it does NOT fail the flow. It hands control to the agent
 * from that point, which repairs the trace and writes the corrected version
 * back. So a UI change costs one slow run, not a permanent regression.
 */

export type ActionKind = "click" | "fill" | "select" | "press" | "goto" | "wait";

export interface Expectation {
  urlContains?: string;
  textPresent?: string;
  textAbsent?: string;
  /** An element matching this selector should exist afterwards. */
  selectorPresent?: string;
}

export interface TraceStep {
  action: ActionKind;
  /** Ranked, most stable first. Empty for goto/wait. */
  selectors: string[];
  /** Human label, for readable traces and debugging. */
  label?: string;
  /** For fill/select/press/goto. `$NAME` is substituted at replay time. */
  value?: string;
  expect?: Expectation;
}

export interface Trace {
  flowId: string;
  goal: string;
  startUrl: string;
  recordedAt: string;
  /** Times this trace replayed cleanly. High counts = high confidence. */
  replays: number;
  /** Times replay broke and the agent had to repair it. */
  repairs: number;
  steps: TraceStep[];
}

function tracePath(flowId: string): string {
  const dir = resolve(config.dataDir, "traces");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `${flowId.replace(/[^a-z0-9_-]/gi, "_")}.json`);
}

export function loadTrace(flowId: string): Trace | undefined {
  const path = tracePath(flowId);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Trace;
  } catch {
    return undefined;
  }
}

export function saveTrace(trace: Trace): void {
  writeFileSync(tracePath(trace.flowId), JSON.stringify(trace, null, 2));
}

/** Build a step from an element the agent chose, captures selectors for replay. */
export function stepFor(
  action: ActionKind,
  element: InteractiveElement | undefined,
  options: { value?: string; expect?: Expectation } = {},
): TraceStep {
  return {
    action,
    selectors: element?.selectors ?? [],
    label: element?.label,
    value: options.value,
    expect: options.expect,
  };
}

export interface ReplayOutcome {
  /** Steps completed before stopping. */
  completed: number;
  /** True if every step replayed and its expectation held. */
  ok: boolean;
  /** Why it stopped, when it didn't finish. */
  reason?: string;
  /** Index of the step that broke, where the agent takes over. */
  failedAt?: number;
}

async function checkExpectation(page: Page, expect: Expectation): Promise<string | undefined> {
  if (expect.urlContains && !page.url().includes(expect.urlContains)) {
    return `expected URL to contain "${expect.urlContains}", got ${page.url()}`;
  }
  if (expect.textPresent) {
    const found = await page
      .getByText(expect.textPresent, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    if (!found) return `expected to see "${expect.textPresent}"`;
  }
  if (expect.textAbsent) {
    const found = await page
      .getByText(expect.textAbsent, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    if (found) return `did not expect to see "${expect.textAbsent}"`;
  }
  if (expect.selectorPresent) {
    const found = await page
      .locator(expect.selectorPresent)
      .first()
      .isVisible()
      .catch(() => false);
    if (!found) return `expected an element matching ${expect.selectorPresent}`;
  }
  return undefined;
}

/** First selector that resolves to exactly one visible element. */
async function resolve1(page: Page, selectors: string[]): Promise<string | undefined> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 1500 })) return selector;
    } catch {
      /* try the next one, this is exactly why the list is ranked */
    }
  }
  return undefined;
}

/**
 * Replay a trace. No model calls at all on the happy path.
 *
 * Stops at the first step that cannot be resolved or whose expectation fails,
 * and reports where, so the agent resumes from precisely there rather than
 * starting the whole flow over.
 */
export async function replay(
  page: Page,
  trace: Trace,
  variables: Record<string, string> = {},
): Promise<ReplayOutcome> {
  for (let i = 0; i < trace.steps.length; i++) {
    const step = trace.steps[i]!;

    try {
      if (step.action === "goto") {
        await page.goto(step.value ?? trace.startUrl, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
      } else if (step.action === "wait") {
        await page.waitForTimeout(Number(step.value ?? 500));
      } else {
        const selector = await resolve1(page, step.selectors);
        if (!selector) {
          return {
            completed: i,
            ok: false,
            failedAt: i,
            reason: `could not find the element for step ${i} (${step.label ?? step.action})`,
          };
        }

        const locator = page.locator(selector).first();
        // $NAME placeholders keep secrets and per-run data out of the trace file.
        const value = (step.value ?? "").replace(
          /\$([A-Z_][A-Z0-9_]*)/g,
          (_, name: string) => variables[name] ?? `$${name}`,
        );

        if (step.action === "click") await locator.click({ timeout: 8000 });
        else if (step.action === "fill") await locator.fill(value, { timeout: 8000 });
        else if (step.action === "select") await locator.selectOption(value, { timeout: 8000 });
        else if (step.action === "press") await locator.press(value || "Enter", { timeout: 8000 });
      }

      // Let the app settle before judging the expectation, but don't hang on
      // pages that hold sockets open.
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

      if (step.expect) {
        const problem = await checkExpectation(page, step.expect);
        if (problem) {
          return { completed: i, ok: false, failedAt: i, reason: `step ${i}: ${problem}` };
        }
      }
    } catch (error) {
      return {
        completed: i,
        ok: false,
        failedAt: i,
        reason: `step ${i} threw: ${error instanceof Error ? error.message.split("\n")[0] : error}`,
      };
    }
  }

  return { completed: trace.steps.length, ok: true };
}

/**
 * Confidence that a trace is still worth replaying.
 *
 * A trace that keeps needing repair is describing a page that keeps changing;
 * at some point replaying it first is just wasted latency before the agent runs
 * anyway.
 */
export function traceIsTrustworthy(trace: Trace): boolean {
  if (trace.steps.length === 0) return false;
  if (trace.replays === 0) return true; // fresh, give it a chance
  return trace.repairs / (trace.replays + trace.repairs) < 0.5;
}

/** Snapshot the current page as an expectation for the step just taken. */
export async function captureExpectation(page: Page): Promise<Expectation> {
  const observation = await observe(page);
  const url = new URL(observation.url);
  return {
    urlContains: url.pathname === "/" ? undefined : url.pathname,
    // A short distinctive phrase from the page, enough to notice the flow went
    // somewhere else, without being so specific that copy edits break replay.
    textPresent: observation.text.split(/[.!?]\s/)[0]?.slice(0, 40) || undefined,
  };
}
