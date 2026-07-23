import {
  attemptsFor,
  causalFor,
  failuresByFingerprint,
  failuresOnRoute,
  failuresTouchingFiles,
  outcomeFor,
  recordById,
  searchText,
} from "./store.ts";
import type { FailureRecord, RecalledCase } from "./types.ts";

/**
 * "Have we seen this before?"
 *
 * Five independent matchers, because similarity in software failures is not one
 * thing. Two bugs can be the same because they are literally identical, because
 * they live in the same code, or because they share a shape ("a control lost its
 * handler") while sharing no words at all. A single measure misses two of those.
 *
 *   1. FINGERPRINT   Identical defect recurring. Definitive.
 *   2. FILE OVERLAP  Different symptom, same code. Often the real repeat.
 *   3. LEXICAL       Similar error text or reasoning.
 *   4. LOCATION      Same route and failure class.
 *   5. CLASS         Same kind of failure anywhere, weakest, breaks ties.
 *
 * Scores are combined rather than chosen between, so a case that two matchers
 * both like outranks one that a single matcher loves. Same reasoning as the
 * retrieval fusion in src/retrieve, signals fail in uncorrelated ways.
 */

const WEIGHTS = {
  fingerprint: 1.0,
  fileOverlap: 0.55,
  lexical: 0.35,
  location: 0.3,
  class: 0.12,
} as const;

/** Below this a case is noise and would only distract the agent. */
const MIN_SIMILARITY = 0.25;

export interface MatchQuery {
  projectId: string;
  fingerprint: string;
  signalClass: string;
  route: string;
  message: string;
  /** Files retrieval surfaced for the CURRENT failure. */
  implicatedFiles: string[];
  /** Exclude the failure we are currently working on. */
  excludeFailureId?: string;
}

/** Overlap between two file sets, 0..1. Standard Jaccard. */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface Candidate {
  failure: FailureRecord;
  score: number;
  matchedBy: string[];
  reasoning: string[];
}

export function findSimilarCases(query: MatchQuery, limit = 5): RecalledCase[] {
  const candidates = new Map<string, Candidate>();

  const add = (
    failure: FailureRecord,
    matcher: string,
    contribution: number,
    why: string,
  ): void => {
    if (failure.id === query.excludeFailureId) return;
    const existing = candidates.get(failure.id) ?? {
      failure,
      score: 0,
      matchedBy: [],
      reasoning: [],
    };
    existing.score += contribution;
    if (!existing.matchedBy.includes(matcher)) existing.matchedBy.push(matcher);
    existing.reasoning.push(why);
    candidates.set(failure.id, existing);
  };

  // 1. Exact recurrence. If this fires, the same defect has come back, // which usually means the earlier fix was incomplete, and that is the
  // single most useful thing the agent can know.
  for (const failure of failuresByFingerprint(query.projectId, query.fingerprint)) {
    add(
      failure,
      "fingerprint",
      WEIGHTS.fingerprint,
      `Identical defect seen before on ${failure.at.slice(0, 10)}, this is a recurrence, so the previous fix did not hold.`,
    );
  }

  // 2. Same code, possibly different symptom. Frequently the real repeat: the
  // module is fragile, and the specific error text is incidental.
  for (const { failure, sharedFiles } of failuresTouchingFiles(
    query.projectId,
    query.implicatedFiles,
    30,
  )) {
    const overlap = jaccard(query.implicatedFiles, failure.implicatedFiles);
    if (overlap <= 0) continue;
    add(
      failure,
      "file-overlap",
      WEIGHTS.fileOverlap * overlap,
      `Shares ${sharedFiles.slice(0, 3).join(", ")} with a past failure (${(overlap * 100).toFixed(0)}% file overlap).`,
    );
  }

  // 3. Lexical similarity over messages and past reasoning.
  const hits = searchText(query.projectId, `${query.message} ${query.signalClass}`, 20);
  hits.forEach((hit, index) => {
    const record = recordById(query.projectId, hit.id);
    if (!record) return;

    // A hit may be an attempt or a lesson rather than the failure itself, // resolve back to the failure it belongs to.
    const failureId =
      record.type === "failure"
        ? record.id
        : "failureId" in record
          ? (record as { failureId: string }).failureId
          : undefined;
    if (!failureId) return;

    const failure =
      record.type === "failure"
        ? record
        : (recordById(query.projectId, failureId) as FailureRecord | undefined);
    if (!failure || failure.type !== "failure") return;

    // Rank-decayed, so the 20th lexical hit contributes almost nothing.
    add(
      failure,
      "lexical",
      WEIGHTS.lexical / (1 + index * 0.4),
      `Similar wording to a past ${failure.signalClass} on ${failure.route}.`,
    );
  });

  // 4. Same place, same kind.
  for (const failure of failuresOnRoute(query.projectId, query.route, 20)) {
    const sameClass = failure.signalClass === query.signalClass;
    add(
      failure,
      "location",
      WEIGHTS.location * (sameClass ? 1 : 0.4),
      sameClass
        ? `Same failure class on the same route (${query.route}).`
        : `Different failure class on the same route (${query.route}).`,
    );
  }

  // 5. Same class anywhere. Weak on purpose, only useful for breaking ties,
  // and it would dominate everything if weighted higher.
  for (const [, candidate] of candidates) {
    if (candidate.failure.signalClass === query.signalClass) {
      candidate.score += WEIGHTS.class;
    }
  }

  const maxPossible =
    WEIGHTS.fingerprint + WEIGHTS.fileOverlap + WEIGHTS.lexical + WEIGHTS.location + WEIGHTS.class;

  return [...candidates.values()]
    .map((candidate) => ({
      failure: candidate.failure,
      attempts: attemptsFor(query.projectId, candidate.failure.id),
      outcome: outcomeFor(query.projectId, candidate.failure.id),
      causal: causalFor(query.projectId, candidate.failure.id),
      similarity: Math.min(1, candidate.score / maxPossible),
      matchedBy: candidate.matchedBy,
      reasoning: [...new Set(candidate.reasoning)],
    }))
    .filter((c) => c.similarity >= MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * Split recalled cases into what to try and what to avoid.
 *
 * The avoid-list is the underrated half. A past attempt that made the score
 * *worse* is a tested, disproven hypothesis, reusing it wastes a full iteration
 * and, if the agent is unlucky, ships a regression that was already known to be
 * one.
 */
export interface Guidance {
  /** Approaches that verifiably worked on a similar failure. */
  proven: { approach: string; rationale: string; fromCase: string; confirmed: boolean }[];
  /** Approaches already tried and rejected. */
  disproven: { approach: string; whyItFailed: string; scoreDelta?: number }[];
  /** Distilled causal lessons. */
  lessons: string[];
  /** True if this exact defect has returned. */
  isRecurrence: boolean;
}

export function buildGuidance(cases: RecalledCase[]): Guidance {
  const proven: Guidance["proven"] = [];
  const disproven: Guidance["disproven"] = [];
  const lessons: string[] = [];
  let isRecurrence = false;

  for (const recalled of cases) {
    if (recalled.matchedBy.includes("fingerprint")) isRecurrence = true;
    if (recalled.causal?.lesson) lessons.push(recalled.causal.lesson);

    for (const attempt of recalled.attempts) {
      if (attempt.outcome === "kept") {
        proven.push({
          approach: attempt.approach,
          rationale: attempt.rationale,
          fromCase: `${recalled.failure.signalClass} on ${recalled.failure.route} (${recalled.failure.at.slice(0, 10)})`,
          // Only "confirmed" means real-world verification, not just a better probe score.
          confirmed: recalled.outcome?.verdict === "confirmed",
        });
      } else if (attempt.outcome === "reverted") {
        disproven.push({
          approach: attempt.approach,
          whyItFailed: attempt.whyItFailed ?? "the probe score did not improve",
          scoreDelta:
            attempt.scoreAfter !== undefined && attempt.scoreBefore !== undefined
              ? attempt.scoreAfter - attempt.scoreBefore
              : undefined,
        });
      }
    }
  }

  return { proven, disproven, lessons: [...new Set(lessons)], isRecurrence };
}
