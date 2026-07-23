import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";

/**
 * Backend verification.
 *
 * Hand-written postconditions have two problems: someone must author them per
 * flow, and they only check what that person thought to check. Watching the
 * server directly fixes both, during a flow we ask the app what it actually
 * did, and judge the run on that rather than on what the screen claimed.
 *
 * Three layers, in increasing power and decreasing generality:
 *
 *   1. INVARIANTS      Zero config. No 5xx, no unhandled exception. If any of
 * these fire the flow failed, whatever the UI showed.
 *   2. LEARNED SHAPE   Record what a healthy run does, then assert later runs
 * match. This is what catches "the POST never fired",
 * the signature of silent breakage.
 *   3. POSTCONDITIONS  Hand-written business assertions (verify.ts), for the
 * things only a human knows to check.
 */

export interface BackendRequest {
  at: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
}

export interface BackendError {
  at: string;
  route: string;
  name: string;
  message: string;
  stack?: string;
  handled: boolean;
}

export interface BackendTrace {
  since: string;
  now: string;
  requests: BackendRequest[];
  errors: BackendError[];
  summary: {
    total: number;
    serverErrors: number;
    clientErrors: number;
    unhandledErrors: number;
    slowest: number;
  };
}

/** Ask the app what it did since `since`. */
export async function collectTrace(
  traceUrl: string,
  since: string,
  token?: string,
): Promise<BackendTrace | undefined> {
  try {
    const url = new URL(traceUrl);
    url.searchParams.set("since", since);

    const response = await fetch(url, {
      headers: token ? { "x-recursive-token": token } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as BackendTrace;
  } catch {
    // No server SDK installed, or the app is down. Backend verification simply
    // doesn't contribute, it never blocks the sweep.
    return undefined;
  }
}

// ---------------------------------------------------------- 1. invariants

export interface BackendFinding {
  severity: "failure" | "warning";
  title: string;
  detail: string;
  /** Attached to the signal so repair has something concrete to work from. */
  evidence?: string;
}

/**
 * Checks that need no configuration and are true of every healthy request.
 *
 * Deliberately narrow. Anything arguable belongs in the learned shape, because
 * a check that fires on healthy runs trains people to ignore the whole system.
 */
export function checkInvariants(trace: BackendTrace): BackendFinding[] {
  const findings: BackendFinding[] = [];

  const serverErrors = trace.requests.filter((r) => r.status >= 500);
  if (serverErrors.length) {
    findings.push({
      severity: "failure",
      title: `${serverErrors.length} server error(s) during the flow`,
      detail: serverErrors
        .slice(0, 5)
        .map((r) => `${r.method} ${r.route} → ${r.status}`)
        .join(", "),
      evidence: JSON.stringify(serverErrors.slice(0, 10), null, 2),
    });
  }

  const unhandled = trace.errors.filter((e) => !e.handled);
  if (unhandled.length) {
    findings.push({
      severity: "failure",
      title: `${unhandled.length} unhandled exception(s) on the server`,
      detail: unhandled
        .slice(0, 3)
        .map((e) => `${e.name}: ${e.message}`)
        .join(" | "),
      evidence: unhandled[0]?.stack,
    });
  }

  const handled = trace.errors.filter((e) => e.handled);
  if (handled.length) {
    // Handled errors are a warning, not a failure, plenty of apps log expected
    // validation errors, and failing on those would make the sweep useless.
    findings.push({
      severity: "warning",
      title: `${handled.length} handled error(s) logged`,
      detail: handled
        .slice(0, 3)
        .map((e) => `${e.name}: ${e.message}`)
        .join(" | "),
    });
  }

  return findings;
}

// -------------------------------------------------------- 2. learned shape

export interface FlowShape {
  flowId: string;
  recordedAt: string;
  /** Normalized `METHOD route` seen on a healthy run, with typical status. */
  calls: { key: string; status: number; count: number }[];
  /** Runs merged into this shape. More runs = more trustworthy. */
  samples: number;
}

function shapePath(): string {
  mkdirSync(config.dataDir, { recursive: true });
  return resolve(config.dataDir, "flow-shapes.json");
}

export function loadShapes(): Record<string, FlowShape> {
  const path = shapePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, FlowShape>;
  } catch {
    return {};
  }
}

function saveShapes(shapes: Record<string, FlowShape>): void {
  writeFileSync(shapePath(), JSON.stringify(shapes, null, 2));
}

function callKey(request: BackendRequest): string {
  return `${request.method} ${request.route}`;
}

/**
 * Learn (or reinforce) the shape of a healthy run.
 *
 * Only ever called after a run that passed every other check, a shape learned
 * from a broken run would enshrine the bug as normal, and the system would go
 * quiet about exactly the thing it should be shouting about.
 *
 * Calls are kept only if they appear on MOST healthy runs. A one-off analytics
 * beacon that fires half the time would otherwise become a required call and
 * fail every second sweep.
 */
export function learnShape(flowId: string, trace: BackendTrace): FlowShape {
  const shapes = loadShapes();
  const existing = shapes[flowId];

  const seen = new Map<string, { status: number; count: number }>();
  for (const request of trace.requests) {
    if (request.method === "MARK") continue;
    const key = callKey(request);
    const entry = seen.get(key) ?? { status: request.status, count: 0 };
    entry.count++;
    seen.set(key, entry);
  }

  if (!existing) {
    const shape: FlowShape = {
      flowId,
      recordedAt: new Date().toISOString(),
      calls: [...seen].map(([key, v]) => ({ key, status: v.status, count: v.count })),
      samples: 1,
    };
    shapes[flowId] = shape;
    saveShapes(shapes);
    return shape;
  }

  // Merge: a call survives only if it keeps showing up. This prunes flaky
  // beacons out of the "expected" set over time rather than trusting run one.
  const merged = new Map(existing.calls.map((c) => [c.key, c]));
  for (const [key, value] of seen) {
    const prior = merged.get(key);
    if (prior) prior.count = Math.max(prior.count, value.count);
    else merged.set(key, { key, status: value.status, count: value.count });
  }

  const shape: FlowShape = {
    flowId,
    recordedAt: new Date().toISOString(),
    calls: [...merged.values()],
    samples: existing.samples + 1,
  };
  shapes[flowId] = shape;
  saveShapes(shapes);
  return shape;
}

/**
 * Compare a run against the learned healthy shape.
 *
 * The high-value check is MISSING calls. If a healthy checkout always does
 * `POST /api/orders` and this run didn't, the button did nothing, which is
 * precisely the silent failure a green UI hides. A status change is the more
 * obvious case and also caught.
 */
export function compareToShape(
  trace: BackendTrace,
  shape: FlowShape,
  options: { minSamples?: number } = {},
): BackendFinding[] {
  const minSamples = options.minSamples ?? 2;

  // One sample is an anecdote. Asserting against it would produce noise on the
  // second run and destroy trust before the feature ever proves itself.
  if (shape.samples < minSamples) return [];

  const findings: BackendFinding[] = [];

  const actual = new Map<string, number>();
  for (const request of trace.requests) {
    if (request.method === "MARK") continue;
    actual.set(callKey(request), request.status);
  }

  for (const expected of shape.calls) {
    if (!actual.has(expected.key)) {
      findings.push({
        severity: "failure",
        title: `expected server call never happened: ${expected.key}`,
        detail:
          `A healthy run of this flow calls ${expected.key} (seen in ${shape.samples} prior run(s)); ` +
          `this run did not. The action almost certainly did nothing.`,
      });
      continue;
    }

    const status = actual.get(expected.key)!;
    // Compare status *class*, 200 vs 201 is not a regression, 200 vs 500 is.
    if (Math.floor(status / 100) !== Math.floor(expected.status / 100)) {
      findings.push({
        severity: "failure",
        title: `${expected.key} returned ${status}, normally ${expected.status}`,
        detail: `Status class changed from ${Math.floor(expected.status / 100)}xx to ${Math.floor(status / 100)}xx.`,
      });
    }
  }

  return findings;
}

// ------------------------------------------------------------ orchestration

export interface BackendVerification {
  available: boolean;
  findings: BackendFinding[];
  /** True if any finding is a failure. */
  failed: boolean;
  trace?: BackendTrace;
  shape?: FlowShape;
}

/**
 * Full backend check for one flow run.
 *
 * `uiPassed` gates learning: a shape is only recorded from a run that looked
 * healthy on every other axis.
 */
export async function verifyBackend(input: {
  flowId: string;
  traceUrl?: string;
  token?: string;
  since: string;
  uiPassed: boolean;
}): Promise<BackendVerification> {
  if (!input.traceUrl) return { available: false, findings: [], failed: false };

  const trace = await collectTrace(input.traceUrl, input.since, input.token);
  if (!trace) return { available: false, findings: [], failed: false };

  const findings = checkInvariants(trace);

  const shapes = loadShapes();
  const shape = shapes[input.flowId];
  if (shape) findings.push(...compareToShape(trace, shape));

  const failed = findings.some((f) => f.severity === "failure");

  // Only learn from a run that was clean on every axis. Learning from a broken
  // run would bake the bug in as expected behaviour.
  if (!failed && input.uiPassed) {
    return { available: true, findings, failed, trace, shape: learnShape(input.flowId, trace) };
  }

  return { available: true, findings, failed, trace, shape };
}
