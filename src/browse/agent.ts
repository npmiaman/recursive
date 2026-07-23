import { z } from "zod";
import type { Page } from "playwright";
import { resolveProvider } from "../llm/provider.ts";
import { observe, renderObservation, type Observation } from "./observe.ts";
import {
  captureExpectation,
  loadTrace,
  replay,
  saveTrace,
  stepFor,
  traceIsTrustworthy,
  type Trace,
  type TraceStep,
} from "./trace.ts";

/**
 * The browsing agent loop.
 *
 * Structured so that the model is the FALLBACK, not the default path:
 *
 *   1. If a trace exists and has been reliable, replay it. Zero model calls.
 *   2. If replay breaks at step N, the model takes over from step N, not from
 * the beginning. A moved button costs one step of thinking, not a whole run.
 *   3. On success, write the trace back so the next run is fast again.
 *
 * The model never sees a screenshot. It gets a numbered list of interactive
 * elements and answers with an index, which is ~5-10× cheaper per step and
 * removes selector-guessing from the loop entirely (see observe.ts).
 */

const Decision = z.object({
  thought: z.string().describe("One short sentence on why this action."),
  action: z
    .enum(["click", "fill", "select", "press", "goto", "done", "fail"])
    .describe("done = goal achieved. fail = the product is broken; say why."),
  index: z
    .number()
    .optional()
    .describe("Element index from the list. Required for click/fill/select/press."),
  value: z
    .string()
    .optional()
    .describe("Text for fill, option for select, key for press, URL for goto."),
  reason: z.string().optional().describe("For done/fail: what you observed that justifies it."),
});

export interface BrowseFlow {
  id: string;
  goal: string;
  expect: string;
  url: string;
  context?: string;
  maxSteps?: number;
}

export interface BrowseResult {
  status: "passed" | "failed" | "error";
  summary: string;
  transcript: string;
  durationMs: number;
  /** Model calls made. Zero means a pure replay, the point of the whole design. */
  modelCalls: number;
  steps: number;
  /** How the run was carried out, for reporting the speedup. */
  path: "replay" | "repair" | "fresh";
}

const SYSTEM = `You drive a web browser to test whether a product works.

You are given a numbered list of interactive elements. Choose ONE action per turn
and refer to elements by index.

Rules:
- You are TESTING, not fixing. If a control does not work, answer "fail" and say
 exactly what you did and what happened. Do NOT find another route to the goal, a workaround hides the bug, which makes the whole test worthless.
- Answer "done" only when you can see concrete evidence the goal was reached.
- Prefer elements marked in-viewport.
- If an action produced no visible change, that itself is likely the bug. Say so
 rather than clicking something else.`;

function renderVariables(value: string | undefined, variables: Record<string, string>): string {
  if (!value) return "";
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name: string) => variables[name] ?? `$${name}`);
}

/** Only ever called for actions that touch the page, `done`/`fail` return earlier. */
type PageAction = Exclude<z.infer<typeof Decision>["action"], "done" | "fail">;

async function act(
  page: Page,
  decision: z.infer<typeof Decision> & { action: PageAction },
  observation: Observation,
  variables: Record<string, string>,
): Promise<{ ok: boolean; detail: string; step?: TraceStep }> {
  const element =
    decision.index !== undefined
      ? observation.elements.find((e) => e.index === decision.index)
      : undefined;

  const value = renderVariables(decision.value, variables);

  try {
    if (decision.action === "goto") {
      await page.goto(value, { waitUntil: "domcontentloaded", timeout: 20_000 });
      return {
        ok: true,
        detail: `navigated to ${value}`,
        step: stepFor("goto", undefined, { value }),
      };
    }

    if (!element) {
      return { ok: false, detail: `no element at index ${decision.index}` };
    }
    if (element.selectors.length === 0) {
      return { ok: false, detail: `element ${element.index} has no usable selector` };
    }

    const locator = page.locator(element.selectors[0]!).first();

    if (decision.action === "click") await locator.click({ timeout: 8000 });
    else if (decision.action === "fill") await locator.fill(value, { timeout: 8000 });
    else if (decision.action === "select") await locator.selectOption(value, { timeout: 8000 });
    else if (decision.action === "press") await locator.press(value || "Enter", { timeout: 8000 });

    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

    return {
      ok: true,
      detail: `${decision.action} on [${element.index}] "${element.label}"`,
      step: stepFor(decision.action, element, { value: decision.value }),
    };
  } catch (error) {
    return {
      ok: false,
      detail: `${decision.action} failed: ${error instanceof Error ? error.message.split("\n")[0] : error}`,
    };
  }
}

export async function runBrowseFlow(
  page: Page,
  flow: BrowseFlow,
  options: { variables?: Record<string, string>; baseUrl: string; noReplay?: boolean } = {
    baseUrl: "",
  },
): Promise<BrowseResult> {
  const started = Date.now();
  const transcript: string[] = [];
  const variables = options.variables ?? {};
  const maxSteps = flow.maxSteps ?? 30;

  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => consoleErrors.push(e.message.slice(0, 300)));

  const startUrl = new URL(flow.url, options.baseUrl).toString();
  const recorded: TraceStep[] = [];
  let modelCalls = 0;
  let resumeFrom = 0;
  let path: BrowseResult["path"] = "fresh";

  // ---- 1. Replay ---------------------------------------------------------
  const existing = loadTrace(flow.id);
  if (existing && !options.noReplay && traceIsTrustworthy(existing)) {
    transcript.push(`replaying ${existing.steps.length} recorded step(s)…`);
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });

    const outcome = await replay(page, existing, variables);

    if (outcome.ok) {
      // Fast path: the entire flow ran with no model involvement at all.
      existing.replays++;
      saveTrace(existing);
      transcript.push(`replay completed all ${outcome.completed} steps with 0 model calls`);
      return {
        status: "passed",
        summary: `PASS (replayed ${outcome.completed} steps, no model calls)`,
        transcript: transcript.join("\n"),
        durationMs: Date.now() - started,
        modelCalls: 0,
        steps: outcome.completed,
        path: "replay",
      };
    }

    // Replay broke. That is information, not a failure, the page changed, so
    // hand over to the model FROM THAT STEP rather than restarting.
    transcript.push(`replay stopped at step ${outcome.failedAt}: ${outcome.reason}`);
    transcript.push(`handing over to the agent from step ${outcome.failedAt}`);
    recorded.push(...existing.steps.slice(0, outcome.completed));
    resumeFrom = outcome.completed;
    existing.repairs++;
    saveTrace(existing);
    path = "repair";
  } else {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    recorded.push(stepFor("goto", undefined, { value: startUrl }));
  }

  // ---- 2. Agent loop -----------------------------------------------------
  const history: string[] = [];
  let lastHash = "";
  let repeatedObservations = 0;

  for (let step = resumeFrom; step < maxSteps; step++) {
    const observation = await observe(page, consoleErrors);

    // The page didn't change after the last action. Usually the bug itself, // tell the model plainly rather than letting it wander.
    if (observation.hash === lastHash) {
      repeatedObservations++;
      if (repeatedObservations >= 2) {
        history.push("NOTE: the last action produced no visible change to the page.");
      }
    } else {
      repeatedObservations = 0;
    }
    lastHash = observation.hash;

    const prompt = [
      `GOAL: ${flow.goal}`,
      `SUCCESS LOOKS LIKE: ${flow.expect}`,
      flow.context ? `CONTEXT: ${flow.context}` : "",
      "",
      renderObservation(observation),
      "",
      history.length ? `WHAT YOU HAVE DONE:\n${history.slice(-8).join("\n")}` : "",
      "",
      "What is your next action?",
    ]
      .filter(Boolean)
      .join("\n");

    let decision: z.infer<typeof Decision>;
    try {
      modelCalls++;
      decision = await resolveProvider().structured(Decision, prompt, {
        system: SYSTEM,
        effort: "low", // one small decision per step; depth here is wasted
        maxTokens: 800,
      });
    } catch (error) {
      return {
        status: "error",
        summary: `model call failed: ${error instanceof Error ? error.message : error}`,
        transcript: transcript.join("\n"),
        durationMs: Date.now() - started,
        modelCalls,
        steps: step,
        path,
      };
    }

    transcript.push(`[${step}] ${decision.thought}`);

    if (decision.action === "done") {
      // Success, persist the trace so the next run is a pure replay.
      const trace: Trace = {
        flowId: flow.id,
        goal: flow.goal,
        startUrl,
        recordedAt: new Date().toISOString(),
        replays: existing?.replays ?? 0,
        repairs: existing?.repairs ?? 0,
        steps: recorded,
      };
      saveTrace(trace);

      return {
        status: "passed",
        summary: `PASS, ${decision.reason ?? "goal reached"}`,
        transcript: transcript.join("\n"),
        durationMs: Date.now() - started,
        modelCalls,
        steps: step + 1,
        path,
      };
    }

    if (decision.action === "fail") {
      return {
        status: "failed",
        summary: `FAIL, ${decision.reason ?? decision.thought}`,
        transcript: [...transcript, `console errors: ${consoleErrors.slice(-3).join(" | ")}`].join(
          "\n",
        ),
        durationMs: Date.now() - started,
        modelCalls,
        steps: step + 1,
        path,
      };
    }

    const outcome = await act(
      page,
      decision as z.infer<typeof Decision> & { action: PageAction },
      observation,
      variables,
    );
    transcript.push(`      ${outcome.detail}`);
    history.push(`${decision.action}: ${outcome.detail}`);

    if (outcome.ok && outcome.step) {
      // Capture what the page looked like after, so replay can assert it later.
      outcome.step.expect = await captureExpectation(page);
      recorded.push(outcome.step);
    }
  }

  return {
    status: "failed",
    summary: `FAIL, gave up after ${maxSteps} steps without reaching the goal`,
    transcript: transcript.join("\n"),
    durationMs: Date.now() - started,
    modelCalls,
    steps: maxSteps,
    path,
  };
}
