/**
 * Long-term memory.
 *
 * Recursive currently starts from zero on every failure. It re-derives what
 * broke, re-searches the codebase, re-invents a fix, even when it solved the
 * same thing three weeks ago. Memory is what turns a tool that repeats itself
 * into one that accumulates judgement.
 *
 * The model is **case-based reasoning**: retrieve similar past cases, reuse what
 * worked, revise it for the new situation, retain the result. That framing
 * matters because it makes the *failures* as valuable as the successes, knowing
 * "we tried converting the div to a button and the score got worse" saves an
 * entire wasted iteration next time.
 *
 * APPEND-ONLY, PERMANENTLY. There is no delete anywhere in this module, by
 * design. A memory you can prune is a memory you will eventually prune wrongly,
 * usually right before you need it. Records are superseded, never removed.
 *
 * One hard rule: NO PERSONAL DATA. This store holds code, failures and
 * reasoning. Signals are scrubbed before they reach it (see detect/ingest.ts),
 * and nothing here should ever contain a user's data, which is also what keeps
 * "never delete" compatible with erasure obligations.
 */

/** A change to the codebase, the thing that usually causes what follows. */
export interface ChangeRecord {
  type: "change";
  id: string;
  projectId: string;
  at: string;
  /** Commit sha, or a release id. */
  ref: string;
  subject: string;
  author?: string;
  files: string[];
  /** Area classification, so patterns can be found per part of the system. */
  area?: string;
  /** Lines added/removed, size correlates with risk. */
  churn?: { added: number; removed: number };
}

/** Something broke. */
export interface FailureRecord {
  type: "failure";
  id: string;
  projectId: string;
  at: string;
  /** Stable identity of this defect, the primary key for exact recurrence. */
  fingerprint: string;
  signalClass: string;
  route: string;
  message: string;
  /** Stack, transcript, or probe evidence. */
  evidence?: string;
  /** The change we believed caused it. */
  suspectedChangeRef?: string;
  /** Files retrieval surfaced when diagnosing. */
  implicatedFiles: string[];
  affectedSessions?: number;
  severity?: number;
}

/**
 * One attempt at a fix, and, crucially. WHY.
 *
 * The reasoning is stored, not just the diff. A future run needs to know what
 * the agent believed and whether that belief held, otherwise it repeats the same
 * wrong theory with different code.
 */
export interface AttemptRecord {
  type: "attempt";
  id: string;
  projectId: string;
  at: string;
  failureId: string;
  attemptNumber: number;
  /** The hypothesis this attempt was testing. */
  hypothesis: string;
  /** The approach in the agent's own words. */
  approach: string;
  /** Why the agent thought this would work. */
  rationale: string;
  filesChanged: string[];
  /** Probe score before and after, the objective measure. */
  scoreBefore?: number;
  scoreAfter?: number;
  outcome: "kept" | "reverted" | "no-op" | "error";
  /** For reverted attempts: what the agent observed that made it wrong. */
  whyItFailed?: string;
}

/** Did the fix actually work in production, days later? */
export interface OutcomeRecord {
  type: "outcome";
  id: string;
  projectId: string;
  at: string;
  failureId: string;
  verdict: "confirmed" | "no-change" | "regressed" | "inconclusive";
  note: string;
  /** Real-world metric movement, when measurable. */
  metricBefore?: number;
  metricAfter?: number;
}

/**
 * An explicit causal claim: this change caused this failure, and this fix
 * resolved it. Derived rather than asserted, and only written once an outcome
 * confirms it, a guess recorded as fact would poison every future recall.
 */
export interface CausalLink {
  type: "causal";
  id: string;
  projectId: string;
  at: string;
  changeRef?: string;
  failureId: string;
  /** Attempt that resolved it. */
  resolvedByAttemptId?: string;
  /** How much we trust this link. Raised when the same pattern recurs. */
  confidence: number;
  /** Plain-language statement, e.g. "converting a button to a div removed its handler". */
  lesson: string;
}

/**
 * Structural knowledge about a source file. Unlike every other record here,
 * which captures an EVENT, this captures what the codebase IS, the foundation
 * everything else accumulates on top of. See memory/base.ts.
 */
export interface FileKnowledgeRecord {
  type: "file-knowledge";
  id: string;
  projectId: string;
  at: string;
  path: string;
  contentHash: string;
  language: string;
  area: string;
  lines: number;
  exports: string[];
  imports: string[];
  symbols: string[];
  importedBy: number;
  centrality: number;
  summary?: string;
  concepts?: string[];
  impact?: string;
}

export type MemoryRecord =
  ChangeRecord | FailureRecord | AttemptRecord | OutcomeRecord | CausalLink | FileKnowledgeRecord;

/** A past case retrieved as relevant to a new failure. */
export interface RecalledCase {
  failure: FailureRecord;
  attempts: AttemptRecord[];
  outcome?: OutcomeRecord;
  causal?: CausalLink;
  /** 0..1. */
  similarity: number;
  /** Which matchers fired, for explainability. */
  matchedBy: string[];
  /** Human-readable account of why this case was surfaced. */
  reasoning: string[];
}
