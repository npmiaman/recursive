import {
  isFrictionMetric,
  toNumber,
  type ClarityMetricBlock,
  type Snapshot,
} from "../clarity/types.ts";
import { METRIC_TO_KIND, issueId, type Issue } from "./issues.ts";

/**
 * Turn a raw Clarity snapshot into per-URL friction signals.
 *
 * The API returns one block per metric, each holding rows tagged with whichever
 * dimensions were requested. To attribute friction to a page we need the `URL`
 * dimension present; without it every row collapses to a site-wide aggregate
 * and there is nothing specific enough to fix.
 */

/** Pull the URL a row belongs to, tolerating the API's loose row shape. */
function rowUrl(row: Record<string, unknown>): string | undefined {
  const raw = row["URL"] ?? row["Url"] ?? row["url"];
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return normalizeUrl(raw);
}

/** Strip origin, query and trailing slash so /pricing?ref=x === /pricing. */
export function normalizeUrl(raw: string): string {
  let path = raw.trim();
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    /* fall through, treat as a path */
  }
  const q = path.indexOf("?");
  if (q !== -1) path = path.slice(0, q);
  const h = path.indexOf("#");
  if (h !== -1) path = path.slice(0, h);
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
}

/** How many sessions a row represents, across the field names Clarity uses. */
function rowSessions(row: Record<string, unknown>): number {
  for (const key of ["sessionsCount", "totalSessionCount", "subTotal", "sessionsWithMetric"]) {
    const value = row[key];
    if (value !== undefined) {
      const n = toNumber(value);
      if (n > 0) return n;
    }
  }
  return 0;
}

/**
 * Session volume per URL, excluding bots. Bot traffic inflates the denominator
 * and would make real friction look rarer than it is.
 */
export function trafficByUrl(snapshot: Snapshot): Map<string, number> {
  const traffic = new Map<string, number>();
  const block = snapshot.payload.find((b) => b.metricName === "Traffic");
  if (!block) return traffic;

  for (const row of block.information) {
    const url = rowUrl(row);
    if (!url) continue;
    const total = toNumber(row["totalSessionCount"]);
    const bots = toNumber(row["totalBotSessionCount"]);
    const human = Math.max(0, total - bots);
    traffic.set(url, (traffic.get(url) ?? 0) + human);
  }
  return traffic;
}

/** Friction counts per URL for one metric block. */
function frictionByUrl(block: ClarityMetricBlock): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of block.information) {
    const url = rowUrl(row);
    if (!url) continue;
    counts.set(url, (counts.get(url) ?? 0) + rowSessions(row));
  }
  return counts;
}

export interface ExtractOptions {
  /**
   * Ignore URLs below this session count. Friction rates on tiny samples are
   * noise, and shipping a PR against noise is worse than doing nothing.
   */
  minSessions?: number;
  /** Ignore issues affecting fewer than this fraction of sessions. */
  minRate?: number;
}

/**
 * Extract every friction issue present in a snapshot, unranked.
 * Severity is assigned separately in rank.ts.
 */
export function extractIssues(snapshot: Snapshot, options: ExtractOptions = {}): Issue[] {
  const minSessions = options.minSessions ?? 200;
  const minRate = options.minRate ?? 0.01;

  const traffic = trafficByUrl(snapshot);
  if (traffic.size === 0) {
    console.warn(
      "[signals] no URL-dimensioned traffic in snapshot, re-pull with dimension1=URL, " +
        "otherwise friction cannot be attributed to a page.",
    );
    return [];
  }

  const issues: Issue[] = [];

  for (const block of snapshot.payload) {
    if (!isFrictionMetric(block.metricName)) continue;
    const kind = METRIC_TO_KIND[block.metricName];

    for (const [url, affected] of frictionByUrl(block)) {
      const total = traffic.get(url) ?? 0;
      if (total < minSessions) continue;

      const rate = total > 0 ? affected / total : 0;
      if (rate < minRate) continue;

      issues.push({
        id: issueId(url, kind),
        url,
        kind,
        metric: block.metricName,
        affectedSessions: affected,
        totalSessions: total,
        rate,
        severity: 0, // assigned by rank()
      });
    }
  }

  return issues;
}
