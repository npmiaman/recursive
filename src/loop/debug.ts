import { z } from "zod";
import { resolveProvider } from "../llm/provider.ts";
import type { BackendVerification } from "../sweep/backend.ts";
import type { RetrievedContext } from "../retrieve/index.ts";
import { formatContext } from "../retrieve/index.ts";

/**
 * The debugger.
 *
 * This is what runs when a fix did NOT work. It is deliberately a different job
 * from the initial investigation, because the situation is different: we are no
 * longer guessing from symptoms, we now have a *disproven hypothesis* and fresh
 * evidence about what happened when we acted on it.
 *
 * The most common failure mode in automated repair is re-trying variations of an
 * idea that was already wrong. So the prompt forces the model to do the thing a
 * good engineer does on the second attempt: explain why the previous theory was
 * wrong before proposing anything new.
 *
 * Evidence it gets, which the first investigation did not have:
 *   - what the browsing agent saw when it re-ran the actual user flow
 *   - what the server actually did (or failed to do) during that attempt
 *   - the change we made, and the fact it did not help
 *   - everything this project has learned about similar failures
 */

const Diagnosis = z.object({
  whyPreviousAttemptFailed: z
    .string()
    .describe("Explain specifically why the last change did not fix it. Reference the evidence."),
  revisedHypothesis: z
    .string()
    .describe("What you now believe the actual cause is. Say if it is unchanged and why."),
  hypothesisChanged: z
    .boolean()
    .describe("True if this is a genuinely different theory, not a variation of the last one."),
  nextApproach: z.object({
    title: z.string(),
    rationale: z.string().describe("Why this addresses the revised hypothesis."),
    approach: z.string().describe("Concrete implementation guidance."),
    risk: z.enum(["low", "medium", "high"]),
  }),
  /** Honest signal that the loop should stop and fetch a human. */
  needsHuman: z
    .boolean()
    .describe("True if the evidence is insufficient or the fix requires a judgement call."),
  needsHumanReason: z.string().optional(),
  /** What evidence would settle it, if we're stuck. */
  missingEvidence: z.array(z.string()).describe("What you would need to see to be confident."),
});

export type Diagnosis = z.infer<typeof Diagnosis>;

export interface DebugEvidence {
  /** The original failure. */
  failure: { kind: string; route: string; message: string };
  /** What we changed, and what happened. */
  attempts: {
    n: number;
    approach: string;
    hypothesis: string;
    filesChanged: string[];
    /** What the browsing agent saw after this attempt. */
    flowTranscript?: string;
    /** What the server did during the re-check. */
    backendFindings?: string[];
    /** Probe score movement, when measured. */
    scoreDelta?: number;
    whyRejected: string;
  }[];
  /** Code retrieved for this failure. */
  context?: RetrievedContext;
  /** What this project already learned, including approaches already disproven. */
  memory?: string;
  /** Latest backend verification, whether or not an attempt was made. */
  backend?: BackendVerification;
}

const SYSTEM = `You are a senior engineer debugging a fix that did not work.

You have already tried something and it failed. Your job is NOT to propose a
variation of it. Your job is to work out why your previous theory was wrong.

Rules:
- Start from the evidence, not from the previous hypothesis. If the browsing
 agent saw the button still doing nothing after you added a handler, then
  "the handler was missing" was the wrong theory, say so plainly.
- A backend trace showing no request fired means the problem is client-side,
 regardless of what the UI looked like. A 500 means it is server-side. Use this.
- If the same theory keeps producing failed fixes, the theory is wrong. Change it.
- If you genuinely cannot tell from the evidence available, set needsHuman and
 say exactly what you would need to see. Guessing again is worse than stopping.
- Prefer the smallest change that addresses the revised cause.`;

function renderAttempts(evidence: DebugEvidence): string {
  return evidence.attempts
    .map((attempt) => {
      const parts = [
        `### Attempt ${attempt.n}: ${attempt.approach}`,
        `Hypothesis at the time: ${attempt.hypothesis}`,
        `Files changed: ${attempt.filesChanged.join(", ") || "(none)"}`,
        `Result: ${attempt.whyRejected}`,
      ];
      if (attempt.scoreDelta !== undefined) {
        parts.push(
          `Probe score moved ${attempt.scoreDelta >= 0 ? "+" : ""}${attempt.scoreDelta.toFixed(4)} (negative = better)`,
        );
      }
      if (attempt.flowTranscript) {
        parts.push(
          `What the browsing agent saw when it re-ran the real user flow afterwards:\n\`\`\`\n${attempt.flowTranscript.slice(0, 2000)}\n\`\`\``,
        );
      }
      if (attempt.backendFindings?.length) {
        parts.push(
          `What the server did:\n${attempt.backendFindings.map((f) => `- ${f}`).join("\n")}`,
        );
      }
      return parts.join("\n");
    })
    .join("\n\n");
}

export async function diagnoseFailedFix(evidence: DebugEvidence): Promise<Diagnosis> {
  const prompt = `# A fix did not work. Work out why.

## The original failure
**${evidence.failure.kind}** on \`${evidence.failure.route}\`
${evidence.failure.message}

## What has been tried, and what happened

${renderAttempts(evidence)}

${
  evidence.backend?.findings.length
    ? `## Current server behaviour\n\n${evidence.backend.findings
        .map((f) => `- **${f.severity}**: ${f.title}, ${f.detail}`)
        .join("\n")}\n`
    : ""
}
${evidence.memory ? evidence.memory + "\n" : ""}
${evidence.context ? formatContext(evidence.context) : ""}

## Your task

1. Explain why the previous attempt failed, citing the evidence above.
2. State what you now believe the cause is, and be explicit about whether that
 is a genuinely different theory or the same one.
3. Propose the next change.

If the evidence does not support a confident next step, say so instead of guessing.`;

  return resolveProvider().structured(Diagnosis, prompt, {
    system: SYSTEM,
    // The hardest reasoning step in the system, this is where depth pays for
    // itself, because a wrong theory here costs another whole cycle.
    effort: "high",
    maxTokens: 16000,
  });
}
