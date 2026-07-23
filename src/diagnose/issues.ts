import type { FrictionMetric } from "../clarity/types.ts";

/** What kind of defect a friction metric implies. Drives which scorer runs. */
export type IssueKind =
  | "dead-click"
  | "rage-click"
  | "excessive-scroll"
  | "quickback"
  | "script-error"
  | "error-click";

export const METRIC_TO_KIND: Record<FrictionMetric, IssueKind> = {
  DeadClickCount: "dead-click",
  RageClickCount: "rage-click",
  ExcessiveScroll: "excessive-scroll",
  QuickbackClick: "quickback",
  ScriptErrorCount: "script-error",
  ErrorClickCount: "error-click",
};

/** Plain-language statement of what each symptom means about the interface. */
export const KIND_MEANING: Record<IssueKind, string> = {
  "dead-click":
    "Users clicked something that did nothing. Usually an element styled to look interactive (cursor:pointer, button-like styling) with no handler, href, or role — or a control whose handler silently failed.",
  "rage-click":
    "Users clicked the same element repeatedly in quick succession. The control either gave no feedback, was slow, or did not work — the user escalated.",
  "excessive-scroll":
    "Users scrolled far more than the page's information density justifies. Key content or the primary action sits too far below the fold, or the layout buries what people came for.",
  quickback:
    "Users navigated in and immediately bounced back. The destination did not match the promise of the link, or it failed to load usefully fast.",
  "script-error":
    "JavaScript threw during the session. Whatever that script was responsible for is silently broken for those users.",
  "error-click":
    "Users clicked an element that then produced a script error — a direct, reproducible interaction failure.",
};

export interface Trend {
  previousRate: number;
  delta: number;
  /** Positive delta = getting worse. */
  direction: "worsening" | "improving" | "flat";
  daysBetween: number;
}

export interface Issue {
  /** Stable id derived from url+kind, so the same hole keeps its identity across runs. */
  id: string;
  url: string;
  kind: IssueKind;
  metric: FrictionMetric;
  /** Sessions exhibiting this friction in the snapshot window. */
  affectedSessions: number;
  /** Total sessions on this URL in the same window. */
  totalSessions: number;
  /** affectedSessions / totalSessions, 0..1. */
  rate: number;
  /** 0..100 composite priority. See rank.ts for the formula. */
  severity: number;
  trend?: Trend;
  /** Filled in by the investigation agent. */
  hypothesis?: string;
  /** CSS selectors the investigator believes are implicated. */
  suspectSelectors?: string[];
}

export function issueId(url: string, kind: IssueKind): string {
  return `${kind}:${url}`;
}

export function describe(issue: Issue): string {
  const pct = (issue.rate * 100).toFixed(1);
  const trend = issue.trend
    ? ` (${issue.trend.direction}, ${issue.trend.delta >= 0 ? "+" : ""}${(issue.trend.delta * 100).toFixed(1)}pp over ${issue.trend.daysBetween}d)`
    : "";
  return `[${issue.severity.toFixed(0)}] ${issue.kind} on ${issue.url} — ${issue.affectedSessions.toLocaleString()}/${issue.totalSessions.toLocaleString()} sessions (${pct}%)${trend}`;
}
