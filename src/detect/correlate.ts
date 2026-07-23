import { readSignals, readReleases, readIncidents } from "./store.ts";
import {
  incidentId,
  isSilent,
  type Cohort,
  type Confidence,
  type Incident,
  type Signal,
} from "./types.ts";

/**
 * Signals → Incidents.
 *
 * The single most useful correlation is the **release boundary**. If a signal
 * class appears within minutes of a deploy and was absent before it, the cause is
 * almost certainly that deploy, and the containment is a rollback, requiring no
 * diagnosis at all. That is what makes Tier 0 both fast and safe: most production
 * breakage is recent change, and recent change is revertible.
 *
 * Everything else here exists to avoid acting on the cases where that inference
 * does NOT hold.
 */

/** A signal appearing this soon after a release is attributed to it. */
const RELEASE_CORRELATION_WINDOW_MS = 30 * 60 * 1000;

/** How far back we look to decide whether a fingerprint is genuinely novel. */
const NOVELTY_LOOKBACK_MS = 14 * 24 * 3600 * 1000;

/** Below this many sessions, a cluster is noise rather than an incident. */
const MIN_SESSIONS = 3;

export interface CorrelateOptions {
  /** Analysis window. Defaults to the last hour. */
  windowMs?: number;
  minSessions?: number;
}

function dominant<T extends string>(values: (T | undefined)[]): T | undefined {
  const counts = new Map<T, number>();
  let total = 0;
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
    total++;
  }
  if (total === 0) return undefined;
  let best: T | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  // Only call it dominant if it actually dominates, otherwise the cohort is
  // mixed and narrowing containment to it would be wrong.
  return bestCount / total >= 0.8 ? best : undefined;
}

function severityOf(input: {
  sessions: number;
  cls: Signal["class"];
  novel: boolean;
  releaseCorrelated: boolean;
}): number {
  // Reach, log-scaled so one enormous page can't permanently outrank everything.
  const reach = Math.min(1, Math.log10(input.sessions + 1) / 3.5);

  // Loud failures are unambiguous breakage. Silent ones are just as costly but
  // carry more interpretation risk, so they weigh slightly less.
  const classWeight = isSilent(input.cls) ? 0.75 : 1.0;

  // Something that started just now, right after a deploy, is the highest-value
  // thing to act on, it is both most likely real and most cheaply reversible.
  const recency = input.releaseCorrelated ? 1.35 : input.novel ? 1.15 : 1.0;

  return Math.max(0, Math.min(100, 100 * classWeight * reach * recency));
}

/**
 * Confidence gates autonomous action (ARCHITECTURE.md §6).
 * This function is deliberately conservative: it must be easier to reach "low"
 * than "high", because "high" is what lets the system act without a human.
 */
function assessConfidence(input: {
  novel: boolean;
  releaseCorrelated: boolean;
  flag?: string;
  sessions: number;
  cohortNarrow: boolean;
  routes: number;
}): { confidence: Confidence; reasoning: string[] } {
  const reasoning: string[] = [];

  if (input.releaseCorrelated) {
    reasoning.push("Appeared within 30 minutes of a release and was absent before it.");
  }
  if (input.novel) {
    reasoning.push("Fingerprint has no history in the previous 14 days.");
  }
  if (input.flag) {
    reasoning.push(`All signals report feature flag '${input.flag}' active.`);
  }
  if (input.cohortNarrow) {
    reasoning.push("Confined to a single browser/device cohort.");
  }
  if (input.routes > 1) {
    reasoning.push(`Spans ${input.routes} routes, cause may be shared infrastructure.`);
  }
  if (input.sessions < 10) {
    reasoning.push(`Only ${input.sessions} sessions affected, small sample.`);
  }

  // High: we can name the cause and the containment is obvious.
  if (input.releaseCorrelated && input.novel && input.sessions >= MIN_SESSIONS) {
    reasoning.push("→ high: novel failure tightly correlated with a specific release.");
    return { confidence: "high", reasoning };
  }
  if (input.flag && input.novel && input.sessions >= MIN_SESSIONS) {
    reasoning.push("→ high: novel failure isolated to a single feature flag.");
    return { confidence: "high", reasoning };
  }

  // Medium: probably attributable, but containment needs to be narrow.
  if ((input.novel || input.releaseCorrelated) && input.sessions >= MIN_SESSIONS) {
    reasoning.push("→ medium: attributable but not conclusively isolated.");
    return { confidence: "medium", reasoning };
  }

  // Low: long-standing or diffuse. Diagnose it; do not contain it automatically, // there is nothing recent to revert, so any action is a guess.
  reasoning.push("→ low: not novel and not release-correlated; no obvious containment.");
  return { confidence: "low", reasoning };
}

export function correlate(projectId: string, options: CorrelateOptions = {}): Incident[] {
  const windowMs = options.windowMs ?? 3600_000;
  const minSessions = options.minSessions ?? MIN_SESSIONS;

  const recent = readSignals(projectId, windowMs);
  if (recent.length === 0) return [];

  const historical = readSignals(projectId, NOVELTY_LOOKBACK_MS);
  const windowStart = Date.now() - windowMs;
  const priorFingerprints = new Set(
    historical.filter((s) => Date.parse(s.at) < windowStart).map((s) => s.fingerprint),
  );

  const releases = readReleases(projectId);
  const existing = new Map(readIncidents(projectId).map((i) => [i.id, i]));

  // Group by fingerprint.
  const groups = new Map<string, Signal[]>();
  for (const signal of recent) {
    const group = groups.get(signal.fingerprint);
    if (group) group.push(signal);
    else groups.set(signal.fingerprint, [signal]);
  }

  const incidents: Incident[] = [];

  for (const [fp, signals] of groups) {
    const sessions = signals.reduce((sum, s) => sum + s.sessions, 0);
    if (sessions < minSessions) continue;

    const times = signals.map((s) => Date.parse(s.at)).sort((a, b) => a - b);
    const firstSeenMs = times[0]!;
    const first = signals[0]!;

    const novel = !priorFingerprints.has(fp);

    // Attribute to a release only if one landed shortly before the first signal
    // AND the fingerprint is new, a pre-existing defect that happens to follow a
    // deploy is not caused by it, and rolling back would not help.
    const precedingRelease = [...releases].reverse().find((r) => {
      const dt = firstSeenMs - Date.parse(r.at);
      return dt >= 0 && dt <= RELEASE_CORRELATION_WINDOW_MS;
    });
    const releaseCorrelated = Boolean(precedingRelease) && novel;

    const flag = dominant(signals.map((s) => s.flag));
    const cohort: Cohort = {
      browser: dominant(signals.map((s) => s.cohort.browser)),
      os: dominant(signals.map((s) => s.cohort.os)),
      device: dominant(signals.map((s) => s.cohort.device)),
      locale: dominant(signals.map((s) => s.cohort.locale)),
      region: dominant(signals.map((s) => s.cohort.region)),
    };
    const cohortNarrow = Boolean(cohort.browser || cohort.device);
    const routes = new Set(signals.map((s) => s.route)).size;

    const { confidence, reasoning } = assessConfidence({
      novel,
      releaseCorrelated,
      flag,
      sessions,
      cohortNarrow,
      routes,
    });

    const id = incidentId(projectId, fp);
    const prior = existing.get(id);

    incidents.push({
      id,
      projectId,
      fingerprint: fp,
      class: first.class,
      route: first.route,
      firstSeen: prior?.firstSeen ?? new Date(firstSeenMs).toISOString(),
      lastSeen: new Date(times[times.length - 1]!).toISOString(),
      signalCount: signals.reduce((sum, s) => sum + s.count, 0),
      affectedSessions: sessions,
      release: precedingRelease?.id ?? first.release,
      releaseCorrelated,
      novel,
      flag,
      cohort,
      confidence,
      severity: severityOf({ sessions, cls: first.class, novel, releaseCorrelated }),
      // Preserve a status a human or the healer already set; don't silently
      // reopen something that was contained.
      status: prior?.status ?? "open",
      reasoning,
    });
  }

  return incidents.sort((a, b) => b.severity - a.severity);
}

export function describeIncident(incident: Incident): string {
  const tags = [
    incident.releaseCorrelated ? "release-correlated" : null,
    incident.novel ? "novel" : null,
    incident.flag ? `flag:${incident.flag}` : null,
    incident.cohort.browser ?? null,
    incident.cohort.device ?? null,
  ].filter(Boolean);

  return (
    `[${incident.severity.toFixed(0)}] ${incident.class} on ${incident.route}, ` +
    `${incident.affectedSessions} session(s), confidence ${incident.confidence}` +
    (tags.length ? ` (${tags.join(", ")})` : "")
  );
}
