import { buildGuidance, findSimilarCases, type Guidance } from "./match.ts";
import { append, lessons as storedLessons } from "./store.ts";
import type {
  AttemptRecord,
  CausalLink,
  ChangeRecord,
  FailureRecord,
  OutcomeRecord,
  RecalledCase,
} from "./types.ts";

/**
 * Recall, the read side of memory.
 *
 * Turns "we have seen 400 failures" into something an agent can act on in the
 * next thirty seconds: what worked, what provably didn't, and whether this exact
 * defect has come back.
 */

export interface Recollection {
  cases: RecalledCase[];
  guidance: Guidance;
  /** Rendered for the prompt. Empty when memory has nothing useful. */
  prompt: string;
}

export function recall(query: {
  projectId: string;
  fingerprint: string;
  signalClass: string;
  route: string;
  message: string;
  implicatedFiles: string[];
  excludeFailureId?: string;
}): Recollection {
  const cases = findSimilarCases(query, 5);
  const guidance = buildGuidance(cases);
  return { cases, guidance, prompt: renderRecollection(cases, guidance) };
}

/**
 * Render memory for the fix agent.
 *
 * Ordered by how much it should change behaviour: a recurrence first (it means
 * the last fix was wrong), then disproven approaches (never repeat these), then
 * proven ones. Deliberately blunt, hedged guidance gets ignored.
 */
export function renderRecollection(cases: RecalledCase[], guidance: Guidance): string {
  if (cases.length === 0) return "";

  const parts: string[] = ["## What we already know (from past failures in this project)\n"];

  if (guidance.isRecurrence) {
    parts.push(
      "**⚠ THIS EXACT DEFECT HAS OCCURRED BEFORE AND WAS SUPPOSEDLY FIXED.**\n" +
        "The previous fix did not hold. Do not simply re-apply it, work out why it " +
        "failed to stick, and address that instead.\n",
    );
  }

  if (guidance.disproven.length) {
    parts.push("### Already tried and rejected, do NOT repeat these\n");
    for (const item of guidance.disproven.slice(0, 5)) {
      const delta =
        item.scoreDelta !== undefined
          ? ` (score moved ${item.scoreDelta >= 0 ? "+" : ""}${item.scoreDelta.toFixed(4)}, worse or no better)`
          : "";
      parts.push(`- **${item.approach}**, ${item.whyItFailed}${delta}`);
    }
    parts.push("");
  }

  if (guidance.proven.length) {
    parts.push("### Worked on a similar failure\n");
    for (const item of guidance.proven.slice(0, 5)) {
      parts.push(
        `- **${item.approach}**${item.confirmed ? " ✅ *confirmed in production*" : " *(improved the probe score; not yet confirmed in production)*"}\n` +
          `  - Why: ${item.rationale}\n  - From: ${item.fromCase}`,
      );
    }
    parts.push("");
  }

  if (guidance.lessons.length) {
    parts.push("### Lessons from this codebase\n");
    for (const lesson of guidance.lessons.slice(0, 5)) parts.push(`- ${lesson}`);
    parts.push("");
  }

  parts.push("### Similar past failures\n");
  for (const recalled of cases.slice(0, 3)) {
    parts.push(
      `- ${(recalled.similarity * 100).toFixed(0)}% similar, ${recalled.failure.signalClass} on ` +
        `\`${recalled.failure.route}\` (${recalled.failure.at.slice(0, 10)}), matched by ${recalled.matchedBy.join(" + ")}`,
    );
    for (const reason of recalled.reasoning.slice(0, 2)) parts.push(`  - ${reason}`);
  }

  parts.push(
    "\nUse this as evidence, not instruction. If the current failure differs in a way that " +
      "makes a past approach wrong, say so and do something else.",
  );

  return parts.join("\n");
}

// ------------------------------------------------------------ write side

export function rememberChange(input: Omit<ChangeRecord, "type" | "id">): ChangeRecord {
  return append<ChangeRecord>({ ...input, type: "change" });
}

export function rememberFailure(input: Omit<FailureRecord, "type" | "id">): FailureRecord {
  return append<FailureRecord>({ ...input, type: "failure" });
}

export function rememberAttempt(input: Omit<AttemptRecord, "type" | "id">): AttemptRecord {
  return append<AttemptRecord>({ ...input, type: "attempt" });
}

export function rememberOutcome(input: Omit<OutcomeRecord, "type" | "id">): OutcomeRecord {
  return append<OutcomeRecord>({ ...input, type: "outcome" });
}

/**
 * Record a causal lesson.
 *
 * Only written once an outcome supports it. A guess stored as a lesson would be
 * recalled as fact on every future failure, so a wrong one is not merely useless
 *, it actively degrades every later decision.
 */
export function rememberLesson(input: Omit<CausalLink, "type" | "id">): CausalLink {
  return append<CausalLink>({ ...input, type: "causal" });
}

/**
 * Derive a lesson from a resolved failure.
 *
 * Confidence is deliberately conservative: a fix confirmed against real
 * telemetry is worth far more than one that merely improved a proxy score, and
 * the gap between those two is where over-confident automation does damage.
 */
export function deriveLesson(input: {
  projectId: string;
  failure: FailureRecord;
  winningAttempt: AttemptRecord;
  outcome?: OutcomeRecord;
}): CausalLink {
  const confirmed = input.outcome?.verdict === "confirmed";

  const lesson =
    `On ${input.failure.route}, ${input.failure.signalClass} was caused by ` +
    `${input.winningAttempt.hypothesis}. Fixed by: ${input.winningAttempt.approach}.` +
    (confirmed ? " Confirmed against real telemetry." : " Probe-verified only.");

  return rememberLesson({
    projectId: input.projectId,
    at: new Date().toISOString(),
    changeRef: input.failure.suspectedChangeRef,
    failureId: input.failure.id,
    resolvedByAttemptId: input.winningAttempt.id,
    confidence: confirmed ? 0.9 : 0.5,
    lesson,
  });
}

/** Everything the project has learned, most-trusted first. */
export function allLessons(projectId: string): CausalLink[] {
  return storedLessons(projectId, 100);
}
