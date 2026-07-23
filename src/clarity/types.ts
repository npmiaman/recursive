/**
 * Types mirroring the Microsoft Clarity Data Export API.
 * Source: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api
 *
 * Endpoint: GET https://www.clarity.ms/export-data/api/v1/project-live-insights
 * Auth:     Authorization: Bearer <JWT>
 * Params: numOfDays (1|2|3), dimension1, dimension2, dimension3
 */

/** The exact dimension values the API accepts. Anything else is a 400. */
export const DIMENSIONS = [
  "Browser",
  "Device",
  "Country/Region",
  "OS",
  "Source",
  "Medium",
  "Campaign",
  "Channel",
  "URL",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Metric names as they appear in `metricName` on the response envelope. */
export const METRICS = [
  "Traffic",
  "ScrollDepth",
  "EngagementTime",
  "PopularPages",
  "Browser",
  "Device",
  "OS",
  "Country/Region",
  "PageTitle",
  "ReferrerUrl",
  "DeadClickCount",
  "ExcessiveScroll",
  "RageClickCount",
  "QuickbackClick",
  "ScriptErrorCount",
  "ErrorClickCount",
] as const;
export type Metric = (typeof METRICS)[number];

/**
 * The six metrics that describe user *friction* rather than volume.
 * These are the only ones the diagnosis layer treats as symptoms.
 */
export const FRICTION_METRICS = [
  "DeadClickCount",
  "RageClickCount",
  "ExcessiveScroll",
  "QuickbackClick",
  "ScriptErrorCount",
  "ErrorClickCount",
] as const;
export type FrictionMetric = (typeof FRICTION_METRICS)[number];

export function isFrictionMetric(name: string): name is FrictionMetric {
  return (FRICTION_METRICS as readonly string[]).includes(name);
}

/**
 * A single row inside a metric's `information` array. The API returns a loose
 * bag of fields that varies by metric and by which dimensions were requested,
 * so this is intentionally permissive, the known numeric fields are typed and
 * dimension values arrive as extra string keys.
 */
export interface ClarityRow {
  totalSessionCount?: string | number;
  totalBotSessionCount?: string | number;
  distantUserCount?: string | number;
  PagesPerSessionPercentage?: number;
  sessionsCount?: string | number;
  sessionsWithMetricPercentage?: number;
  subTotal?: string | number;
  averageScrollDepth?: number;
  totalTime?: string | number;
  activeTime?: string | number;
  [dimensionOrExtra: string]: unknown;
}

export interface ClarityMetricBlock {
  metricName: string;
  information: ClarityRow[];
}

export type ClarityResponse = ClarityMetricBlock[];

/** One persisted pull from the API, stamped so trends can be computed later. */
export interface Snapshot {
  /** ISO timestamp of when we fetched (API returns UTC). */
  fetchedAt: string;
  /** The `numOfDays` window this snapshot covers. */
  numOfDays: 1 | 2 | 3;
  /** Dimensions requested, in order. */
  dimensions: Dimension[];
  /** Whether this came from the live API or generated fixtures. */
  source: "live" | "mock";
  payload: ClarityResponse;
}

/** Coerce Clarity's stringly-typed numerics without silently producing NaN. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
