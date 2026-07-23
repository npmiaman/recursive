/**
 * Ground-truth verification.
 *
 * THE CENTRAL PROBLEM WITH BROWSING AGENTS: they judge success by looking at the
 * page. But the page is the thing under test. "I see an order confirmation" does
 * not mean an order exists, it means a div rendered. Every one of these has
 * shipped to production somewhere:
 *
 *   - Confirmation page renders; the POST silently 500'd and no order was created.
 *   - "Saved!" toast appears; the write failed and the value reverts on reload.
 *   - Signup succeeds visually; the verification email never sends.
 *   - Payment page says approved; the charge was never captured.
 *
 * An agent that only reads the UI reports all four as PASS. So a flow is only
 * green when something OUTSIDE the UI agrees: an API says the record exists, a
 * webhook fired, a row count went up.
 *
 * This is the difference between "the screen looked right" and "the thing
 * actually happened", and it is the single biggest lever on whether a sweep can
 * be trusted.
 */

export type PostconditionKind = "http" | "absence" | "count-delta";

export interface Postcondition {
  /** Shown in output when it fails. */
  name: string;
  kind: PostconditionKind;

  /** http: the endpoint that proves the effect really happened. */
  url?: string;
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: string;

  /** http: required status. Defaults to 2xx. */
  expectStatus?: number;
  /** http: substring that must appear in the response body. */
  expectBodyContains?: string;
  /** http: substring that must NOT appear, catches error payloads returned as 200. */
  expectBodyMissing?: string;
  /** http: JSON path (dotted) that must exist and be truthy. */
  expectJsonPath?: string;

  /**
   * count-delta: an endpoint returning a number (or JSON with `countPath`).
   * Sampled before and after the flow; the difference must match `expectDelta`.
   * This is the strongest available proof that a write landed.
   */
  countPath?: string;
  expectDelta?: number;
}

export interface VerificationResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationOutcome {
  /** True only if every postcondition passed. */
  passed: boolean;
  results: VerificationResult[];
  /** True when the UI said success but ground truth disagreed, the case this exists for. */
  uiLied: boolean;
}

function resolveJsonPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

async function checkHttp(condition: Postcondition): Promise<VerificationResult> {
  if (!condition.url) {
    return { name: condition.name, passed: false, detail: "no url configured" };
  }

  try {
    const response = await fetch(condition.url, {
      method: condition.method ?? "GET",
      headers: condition.headers,
      body: condition.body,
      signal: AbortSignal.timeout(15_000),
    });

    const expected = condition.expectStatus;
    const statusOk = expected ? response.status === expected : response.ok;
    if (!statusOk) {
      return {
        name: condition.name,
        passed: false,
        detail: `expected ${expected ?? "2xx"}, got ${response.status}`,
      };
    }

    const text = await response.text();

    if (condition.expectBodyContains && !text.includes(condition.expectBodyContains)) {
      return {
        name: condition.name,
        passed: false,
        detail: `response did not contain "${condition.expectBodyContains}"`,
      };
    }
    // Catches the common case of an error object returned with a 200.
    if (condition.expectBodyMissing && text.includes(condition.expectBodyMissing)) {
      return {
        name: condition.name,
        passed: false,
        detail: `response contained "${condition.expectBodyMissing}", which indicates failure`,
      };
    }
    if (condition.expectJsonPath) {
      try {
        const value = resolveJsonPath(JSON.parse(text), condition.expectJsonPath);
        if (value === undefined || value === null || value === false || value === "") {
          return {
            name: condition.name,
            passed: false,
            detail: `${condition.expectJsonPath} was ${JSON.stringify(value)}`,
          };
        }
      } catch {
        return { name: condition.name, passed: false, detail: "response was not valid JSON" };
      }
    }

    return { name: condition.name, passed: true, detail: `${response.status} as expected` };
  } catch (error) {
    return {
      name: condition.name,
      passed: false,
      detail: `request failed: ${error instanceof Error ? error.message : error}`,
    };
  }
}

async function sampleCount(condition: Postcondition): Promise<number | undefined> {
  if (!condition.url) return undefined;
  try {
    const response = await fetch(condition.url, {
      headers: condition.headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    if (!condition.countPath) return Number(text.trim());
    const value = resolveJsonPath(JSON.parse(text), condition.countPath);
    return typeof value === "number" ? value : Number(value);
  } catch {
    return undefined;
  }
}

/** Sample every count-delta baseline before the flow runs. */
export async function captureBaselines(conditions: Postcondition[]): Promise<Map<string, number>> {
  const baselines = new Map<string, number>();
  for (const condition of conditions.filter((c) => c.kind === "count-delta")) {
    const value = await sampleCount(condition);
    if (value !== undefined && Number.isFinite(value)) baselines.set(condition.name, value);
  }
  return baselines;
}

/**
 * Run every postcondition after the flow.
 *
 * `uiPassed` is what rhai concluded from the screen. When the UI says yes and
 * ground truth says no, that is the highest-value finding a sweep can produce,
 * a bug no amount of manual clicking would catch, because it looks correct.
 */
export async function verify(
  conditions: Postcondition[],
  baselines: Map<string, number>,
  uiPassed: boolean,
): Promise<VerificationOutcome> {
  const results: VerificationResult[] = [];

  for (const condition of conditions) {
    if (condition.kind === "http" || condition.kind === "absence") {
      const result = await checkHttp(condition);
      // "absence" inverts: the condition passes when the request does NOT succeed.
      results.push(
        condition.kind === "absence"
          ? { ...result, passed: !result.passed, detail: `(absence) ${result.detail}` }
          : result,
      );
      continue;
    }

    if (condition.kind === "count-delta") {
      const before = baselines.get(condition.name);
      const after = await sampleCount(condition);

      if (before === undefined || after === undefined) {
        results.push({
          name: condition.name,
          passed: false,
          detail: "could not sample the count before or after",
        });
        continue;
      }

      const delta = after - before;
      const expected = condition.expectDelta ?? 1;
      results.push({
        name: condition.name,
        passed: delta === expected,
        detail: `count moved ${before} → ${after} (delta ${delta}, expected ${expected})`,
      });
    }
  }

  const passed = results.length === 0 ? uiPassed : results.every((r) => r.passed);

  return {
    passed,
    results,
    uiLied: uiPassed && results.length > 0 && !passed,
  };
}
