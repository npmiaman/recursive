import type { Snapshot } from "../clarity/types.ts";
import { extractIssues, type ExtractOptions } from "./signals.ts";
import type { Issue, IssueKind, Trend } from "./issues.ts";
import { criticalRoutes } from "../memory/base.ts";

/**
 * How damaging each symptom is, independent of volume.
 *
 * A script error is a hard failure, something is broken for everyone who hits
 * it. Excessive scrolling is a design smell: real, worth fixing, but nobody is
 * blocked. Rage clicking sits between: the user is trying and failing, which is
 * both a failure and a signal of intent, so it outranks a passive dead click.
 */
const KIND_WEIGHT: Record<IssueKind, number> = {
  "script-error": 1.0,
  "error-click": 0.95,
  "rage-click": 0.85,
  "dead-click": 0.7,
  quickback: 0.55,
  "excessive-scroll": 0.35,
};

/**
 * FALLBACK list of money-path prefixes.
 *
 * Used only when base memory has no opinion. It bakes in two bad assumptions,
 * that routes are named in English, and that the product is e-commerce, so a
 * bank calling its payment flow `/txn/initiate` gets no priority boost at all.
 * Once `memory index` has run, criticality comes from what the CODE does
 * (see criticalRoutes in memory/base.ts) and this list is not consulted.
 */
const FALLBACK_CONVERSION_PATHS = [
  "/checkout",
  "/cart",
  "/pricing",
  "/signup",
  "/sign-up",
  "/register",
  "/trial",
  "/demo",
  "/contact",
];

function conversionMultiplier(url: string, projectId?: string): number {
  // Prefer the model's judgement, made from reading the actual code.
  if (projectId) {
    try {
      const critical = criticalRoutes(projectId);
      if (critical.size > 0) {
        for (const route of critical) {
          if (url === route || url.startsWith(route)) return 1.5;
        }
        // Base memory HAS an opinion and this route is not on it, trust that
        // rather than falling back to guessing from the URL spelling.
        return 1.0;
      }
    } catch {
      /* not indexed yet, fall through */
    }
  }
  return FALLBACK_CONVERSION_PATHS.some((p) => url.startsWith(p)) ? 1.5 : 1.0;
}

/**
 * Reach, log-scaled. A page with 10,000 affected sessions matters more than one
 * with 100, but not 100x more, or the homepage would win every argument
 * forever and nothing else would ever get fixed.
 */
function reachScore(affectedSessions: number): number {
  if (affectedSessions <= 0) return 0;
  return Math.min(1, Math.log10(affectedSessions + 1) / 4); // saturates ~10k
}

/**
 * Composite 0..100 priority.
 *
 * severity = 100 · kindWeight · conversionMultiplier · (0.6·reach + 0.4·rate) · trendAmp
 *
 * Reach and rate are both included because either alone misleads: rate alone
 * over-promotes a 90%-broken page nobody visits; reach alone over-promotes a
 * mild annoyance on the highest-traffic page.
 */
export function severityOf(issue: Issue, projectId?: string): number {
  const base = 0.6 * reachScore(issue.affectedSessions) + 0.4 * Math.min(1, issue.rate);
  const trendAmp =
    issue.trend?.direction === "worsening"
      ? 1 + Math.min(0.5, Math.abs(issue.trend.delta) * 5)
      : issue.trend?.direction === "improving"
        ? 0.8
        : 1;

  const score =
    100 * KIND_WEIGHT[issue.kind] * conversionMultiplier(issue.url, projectId) * base * trendAmp;

  return Math.max(0, Math.min(100, score));
}

/**
 * Compare two snapshots to detect whether each issue is getting better or worse.
 * This is the payoff for keeping local history, the API's 3-day window can
 * never show it.
 */
export function attachTrends(
  current: Issue[],
  baseline: Snapshot | undefined,
  options: ExtractOptions = {},
): Issue[] {
  if (!baseline) return current;

  const previous = new Map(
    extractIssues(baseline, { ...options, minRate: 0 }).map((i) => [i.id, i]),
  );
  const daysBetween = Math.max(
    1,
    Math.round((Date.now() - Date.parse(baseline.fetchedAt)) / 86_400_000),
  );

  return current.map((issue) => {
    const before = previous.get(issue.id);
    if (!before) return issue;

    const delta = issue.rate - before.rate;
    // Under ~0.5pp of movement is indistinguishable from sampling noise.
    const direction: Trend["direction"] =
      Math.abs(delta) < 0.005 ? "flat" : delta > 0 ? "worsening" : "improving";

    return {
      ...issue,
      trend: { previousRate: before.rate, delta, direction, daysBetween },
    };
  });
}

/** Extract, trend, score and sort, the full diagnosis pass over a snapshot. */
export function diagnose(
  snapshot: Snapshot,
  baseline?: Snapshot,
  options: ExtractOptions & { projectId?: string } = {},
): Issue[] {
  const withTrends = attachTrends(extractIssues(snapshot, options), baseline, options);
  return withTrends
    .map((issue) => ({ ...issue, severity: severityOf(issue, options.projectId) }))
    .sort((a, b) => b.severity - a.severity);
}
