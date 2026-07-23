import { createHash } from "node:crypto";

/**
 * The unified signal model.
 *
 * The central design decision in Recursive: a rage click and an uncaught
 * exception are the SAME KIND OF THING, evidence that the product is not doing
 * what the user asked. One has a stack trace and one doesn't. Treating them as
 * separate systems is why silent breakage goes undetected for weeks.
 */

export type SignalClass =
  // Loud, client, something threw in the browser.
  | "exception"
  | "unhandled-rejection"
  | "failed-request"
  // Loud, server, the backend failed.
  | "server-error"
  | "api-error"
  | "timeout"
  | "crash"
  // Silent, nothing threw, but the product didn't work.
  | "dead-click"
  | "rage-click"
  | "abandon"
  // Correctness, it ran, and produced the wrong thing.
  | "data-error"
  | "assertion-failed"
  // Pipeline, broken before it ever reached a user.
  | "test-failure"
  | "build-failure"
  // Degradation, working, but not acceptably.
  | "performance-regression"
  | "slow"
  // Synthetic, a check we ran ourselves, no user required.
  | "health-check-failed"
  /**
   * A browsing agent completed (or failed) a real user journey. Distinct from
   * health-check-failed because the evidence is a transcript of what the agent
   * tried and saw, which is a far richer diagnosis input than an assertion.
   */
  | "flow-failure";

export const LOUD_CLASSES: SignalClass[] = [
  "exception",
  "unhandled-rejection",
  "failed-request",
  "server-error",
  "api-error",
  "timeout",
  "crash",
  "assertion-failed",
  "flow-failure",
];

export const SILENT_CLASSES: SignalClass[] = [
  "dead-click",
  "rage-click",
  "abandon",
  "data-error",
  "performance-regression",
];

/**
 * Failures caught before a user ever sees them. Worth separating because the
 * response differs: there is nothing to contain, no user is affected yet, so
 * these skip Tier 0 entirely and go straight to repair.
 */
export const PIPELINE_CLASSES: SignalClass[] = ["test-failure", "build-failure"];

export function isPipeline(cls: SignalClass): boolean {
  return PIPELINE_CLASSES.includes(cls);
}

/** Does this failure class normally carry a stack trace? Drives retrieval. */
export function hasStackTrace(cls: SignalClass): boolean {
  return LOUD_CLASSES.includes(cls) || cls === "test-failure" || cls === "build-failure";
}

export function isSilent(cls: SignalClass): boolean {
  return SILENT_CLASSES.includes(cls);
}

/** Where a signal came from. Affects how much we trust it and how fast it arrives. */
export type SignalSource = "sdk" | "clarity" | "synthetic";

export interface Cohort {
  browser?: string;
  os?: string;
  device?: "desktop" | "mobile" | "tablet";
  locale?: string;
  region?: string;
}

export interface Signal {
  id: string;
  projectId: string;
  class: SignalClass;
  source: SignalSource;
  /** ISO timestamp. */
  at: string;
  /** Normalized path, no origin/query. */
  route: string;
  /** Release/build identifier, if the SDK was configured with one. */
  release?: string;
  cohort: Cohort;
  /** Groups identical occurrences. See fingerprint(). */
  fingerprint: string;
  /** Human-readable summary. */
  message: string;
  /** Stack trace for loud signals. */
  stack?: string;
  /** CSS selector for silent interaction signals. */
  selector?: string;
  /** Feature flag implicated, if the SDK reported one active at the time. */
  flag?: string;
  /** How many occurrences this record represents (SDK batches). */
  count: number;
  /** Distinct sessions represented. */
  sessions: number;
}

/**
 * Stable grouping key.
 *
 * Message text is normalized before hashing, ids, hex, numbers and quoted
 * strings vary per occurrence and would otherwise shatter one defect into
 * thousands of "distinct" signals.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{3,}\b/g, "<n>")
    .replace(/(["'])(?:(?!\1).)*\1/g, "<str>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function fingerprint(input: {
  class: SignalClass;
  route: string;
  message?: string;
  selector?: string;
}): string {
  const basis = [
    input.class,
    input.route,
    input.selector ?? "",
    normalizeMessage(input.message ?? ""),
  ].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

/** Confidence that we know what caused an incident, gates autonomous action. */
export type Confidence = "high" | "medium" | "low";

export type IncidentStatus = "open" | "contained" | "repairing" | "resolved" | "escalated";

export interface Incident {
  id: string;
  projectId: string;
  fingerprint: string;
  class: SignalClass;
  route: string;
  firstSeen: string;
  lastSeen: string;
  signalCount: number;
  affectedSessions: number;
  /** Release the signals cluster around, if any. */
  release?: string;
  /** True if this appeared within the correlation window after a release. */
  releaseCorrelated: boolean;
  /** True if this fingerprint has no history before the current window. */
  novel: boolean;
  /** Feature flag implicated across the signals, if consistent. */
  flag?: string;
  cohort: Cohort;
  confidence: Confidence;
  /** 0..100. */
  severity: number;
  status: IncidentStatus;
  /** Why we reached this confidence, shown to humans, logged for audit. */
  reasoning: string[];
}

export function incidentId(projectId: string, fp: string): string {
  return `${projectId}:${fp}`;
}
