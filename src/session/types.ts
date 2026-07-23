/**
 * Session recording.
 *
 * Every time Recursive does anything, detects, retrieves, repairs, contains,
 * verifies, it records a **run**: a structured, replayable account of what it
 * did, what it decided, and whether that turned out to be right.
 *
 * This is not logging. Logs tell you what happened in one incident; runs tell
 * you whether the *product* works. The single most valuable thing in here is
 * cheap ground truth: when a repair run ends, we know which files the agent
 * actually edited, and we can check whether retrieval had surfaced them. That
 * is a labelled retrieval example, produced for free, from real usage, which
 * is worth far more than any benchmark I can write by hand.
 */

export type RunKind = "detect" | "retrieve" | "repair" | "contain" | "verify" | "health";

export type RunStatus = "running" | "succeeded" | "failed" | "aborted";

export type RunTrigger = "manual" | "scheduled" | "webhook" | "incident";

/** Stages within a run. Ordered roughly as they occur. */
export type Stage =
  | "start"
  | "index"
  | "retrieve"
  | "investigate"
  | "research"
  | "attempt"
  | "score"
  | "decide"
  | "ship"
  | "contain"
  | "verify"
  | "end";

export interface RunEvent {
  runId: string;
  /** Monotonic within a run, so ordering survives out-of-order upload. */
  seq: number;
  at: string;
  stage: Stage;
  /** Short machine-readable event name, e.g. "attempt.kept". */
  type: string;
  /** One-line human summary. */
  message: string;
  /** Milliseconds this step took, when meaningful. */
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface RepoContext {
  name?: string;
  branch?: string;
  headSha?: string;
  /** Never the remote URL, that can carry a token. */
  remoteHost?: string;
}

/**
 * What a run produced. Deliberately shaped around the questions we need
 * answered, not around what happens to be easy to emit.
 */
export interface RunOutcome {
  /** Repair: attempts tried and kept. */
  attemptsTried?: number;
  attemptsKept?: number;
  /** Repair: probe score before and after. */
  scoreBefore?: number;
  scoreAfter?: number;
  /** Repair: files the agent actually changed. GROUND TRUTH for retrieval. */
  editedFiles?: string[];
  /** Retrieve: files retrieval surfaced, in rank order. */
  retrievedFiles?: string[];
  /** Retrieve: rank of the first edited file within retrievedFiles. 0 = missed. */
  retrievalHitRank?: number;
  /** Contain: what action was taken, and whether guardrails allowed it. */
  action?: string;
  actionAllowed?: boolean;
  blockedBy?: string[];
  /** Detect: incidents found. */
  incidentsFound?: number;
  /** Ship: where it landed. */
  branch?: string;
  prUrl?: string;
  /** Any stage: why it stopped, if it stopped badly. */
  failureReason?: string;
}

export interface Run {
  id: string;
  accountId: string;
  projectId: string;
  kind: RunKind;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  repo?: RepoContext;
  /** The failure this run was about, when there is one. */
  subject?: {
    issueId?: string;
    incidentId?: string;
    signalClass?: string;
    route?: string;
  };
  outcome: RunOutcome;
  /** Model provider and engine actually used, for cost and quality attribution. */
  environment?: {
    provider?: string;
    model?: string;
    fixEngine?: string;
    recursiveVersion?: string;
  };
  /** Tokens spent, when the provider reports them. */
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** The payload the CLI uploads. Events are batched with their run. */
export interface RunUpload {
  run: Run;
  events: RunEvent[];
}

/**
 * Did retrieval surface the file the agent actually edited?
 *
 * The self-supervising metric. Every repair run yields one of these for free,
 * so retrieval quality can be measured against real usage rather than a
 * hand-written benchmark that I chose the answers for.
 *
 * Returns the 1-indexed rank of the first edited file in the retrieved list, or
 * 0 if retrieval missed entirely.
 */
export function retrievalHitRank(retrieved: string[], edited: string[]): number {
  if (edited.length === 0 || retrieved.length === 0) return 0;
  for (let i = 0; i < retrieved.length; i++) {
    const candidate = retrieved[i]!;
    if (
      edited.some(
        (file) => file === candidate || file.endsWith(candidate) || candidate.endsWith(file),
      )
    ) {
      return i + 1;
    }
  }
  return 0;
}
