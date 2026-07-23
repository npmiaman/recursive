import { runBrowseFlow } from "../browse/agent.ts";
import { BrowserPool } from "../browse/pool.ts";
import type { Flow } from "./flows.ts";
import { runFlow as runViaRhai, type RhaiOptions, type RhaiResult } from "./rhai.ts";

/**
 * One interface, two browser agents.
 *
 * Until now `sweep` called rhai directly, so the faster internal agent, built
 * and measured, but never connected, could not actually be used. This is the
 * switch.
 *
 * rhai      Separate process, own Chrome, own memory. Battle-tested against
 * real third-party dashboards, and the right choice when a flow
 * needs OAuth popups or a service Recursive has never seen.
 * internal  Runs in-process. Replays a recorded trace with zero model calls
 * when nothing has changed, and only thinks when the page differs.
 *             Measured at ~10× cheaper per observation and sub-second on replay.
 *
 * Both return the same shape, so everything downstream, confirmation, backend
 * verification, signals, repair, is untouched by the choice. That is what makes
 * an honest A/B possible: same flows, same checks, only the driver differs.
 */

export type SweepEngine = "rhai" | "internal";

export interface EngineOptions extends RhaiOptions {
  engine: SweepEngine;
  /** Shared across flows for the internal engine, launching Chrome per flow is waste. */
  pool?: BrowserPool;
  /** Values substituted into `$PLACEHOLDER` in recorded traces. */
  variables?: Record<string, string>;
  /** Force a full agent run even when a trace exists. Used to re-record. */
  noReplay?: boolean;
}

/**
 * Run one flow on the selected engine.
 *
 * The internal engine reports two extra facts on the transcript, how many model
 * calls it made and whether it replayed, because those are the numbers that
 * show whether the speed work is actually paying off in production rather than
 * only on a test fixture.
 */
export async function runFlowWithEngine(
  flow: Flow,
  options: EngineOptions,
): Promise<RhaiResult & { modelCalls?: number; path?: string }> {
  if (options.engine === "rhai") {
    return runViaRhai(flow, options);
  }

  const pool = options.pool ?? new BrowserPool({ headless: options.headless !== false });
  const ownsPool = !options.pool;
  if (ownsPool) await pool.start();

  const { context, page } = await pool.acquire();

  try {
    const result = await runBrowseFlow(
      page,
      {
        id: flow.id,
        goal: flow.goal,
        expect: flow.expect,
        url: flow.url,
        context: flow.context,
        maxSteps: options.maxSteps ?? flow.maxSteps,
      },
      {
        baseUrl: options.baseUrl,
        variables: options.variables,
        noReplay: options.noReplay,
      },
    );

    return {
      flowId: flow.id,
      status: result.status,
      summary: result.summary,
      transcript:
        `engine=internal path=${result.path} modelCalls=${result.modelCalls} steps=${result.steps}\n` +
        result.transcript,
      durationMs: result.durationMs,
      modelCalls: result.modelCalls,
      path: result.path,
    };
  } catch (error) {
    return {
      flowId: flow.id,
      status: "error",
      summary: `internal engine failed: ${error instanceof Error ? error.message : error}`,
      transcript: "",
      durationMs: 0,
      infrastructureError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await pool.release(context);
    if (ownsPool) await pool.stop();
  }
}

/** Check an engine is usable before a sweep starts, not halfway through it. */
export async function enginePreflight(
  engine: SweepEngine,
): Promise<{ ok: boolean; reason?: string }> {
  if (engine === "rhai") {
    const { preflight } = await import("./rhai.ts");
    return preflight();
  }

  // Chromium is the only hard requirement.
  try {
    const pool = new BrowserPool({ headless: true });
    await pool.start();
    await pool.stop();
  } catch (error) {
    return {
      ok: false,
      reason: `could not launch Chromium: ${error instanceof Error ? error.message : error}. Run \`npx playwright install chromium\`.`,
    };
  }

  // A model provider is NOT required.
  //
  // Replaying a recorded trace needs no model at all, that is the entire point
  // of the trace system, and the common case for a nightly sweep where nothing
  // changed. Refusing to start without credentials would block exactly the path
  // the speed work exists to enable. A flow with no trace still needs a model,
  // and fails with a clear message at that point rather than up front.
  try {
    const { resolveProvider } = await import("../llm/provider.ts");
    await resolveProvider().preflight();
  } catch {
    console.warn(
      "[sweep] No model provider configured. Flows with a recorded trace will replay " +
        "normally; any flow needing fresh reasoning will fail.",
    );
  }

  return { ok: true };
}
