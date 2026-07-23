import { z } from "zod";
import { KIND_MEANING, describe, type Issue } from "../diagnose/issues.ts";
import type { Score } from "../score/index.ts";
import { programSection } from "../program.ts";
import { askStructured } from "./claude.ts";

/**
 * The investigation stage. Clarity tells you *that* a page is bleeding and the
 * probes tell you *mechanically* what is wrong; this stage produces the causal
 * story and a pool of candidate fix directions for the hill-climb to explore.
 *
 * Producing several directions rather than one is deliberate. AutoResearch's
 * value comes from cheap parallel exploration, a single "obvious" fix that
 * fails wastes the whole run, whereas a ranked pool gives the loop somewhere to
 * go on iteration two.
 */

const FixDirection = z.object({
  title: z
    .string()
    .describe("Short imperative name, e.g. 'Convert the pricing tier card to a real button'"),
  rationale: z.string().describe("Why this should move the metric, tied to the evidence."),
  approach: z.string().describe("Concrete implementation guidance for the coding agent."),
  risk: z.enum(["low", "medium", "high"]).describe("Blast radius if this is wrong."),
  confidence: z.number().min(0).max(1).describe("How likely this addresses the root cause."),
});

const Investigation = z.object({
  hypothesis: z.string().describe("The single most likely root cause, stated plainly."),
  suspectSelectors: z
    .array(z.string())
    .describe("CSS selectors most likely implicated. Empty if the evidence doesn't identify any."),
  searchTerms: z
    .array(z.string())
    .describe("Terms to search the target repo for, to locate the responsible component."),
  needsExternalResearch: z
    .boolean()
    .describe(
      "True if this looks like a known library/framework bug or needs external best-practice input.",
    ),
  directions: z.array(FixDirection).min(1).max(4).describe("Candidate fixes, best first."),
});

export type Investigation = z.infer<typeof Investigation>;
export type FixDirection = z.infer<typeof FixDirection>;

const SYSTEM = `You are a senior frontend engineer doing root-cause analysis on real user-behavior telemetry.

You are given:
  - A friction signal measured by Microsoft Clarity across real sessions.
  - Mechanical probe evidence from a headless browser that reproduced the symptom.

Your job is to explain the cause and propose concrete, minimal fixes.

Rules:
- Ground every claim in the evidence provided. If the evidence does not identify a
 specific element or file, say so rather than inventing a selector.
- Prefer the smallest change that addresses the cause. Do not propose redesigns,
 refactors, or new abstractions.
- Accessibility and interaction correctness usually fix these symptoms at the root:
 a div that looks clickable should usually become a real <button> or <a>, not gain
 a click handler.
- Distinguish "the control is missing" from "the control exists but fails". They
 have different fixes and the probe evidence usually tells you which.`;

export async function investigate(issue: Issue, score: Score): Promise<Investigation> {
  const prompt = `${programSection()}
## Friction signal (Microsoft Clarity, real sessions)

${describe(issue)}

What this metric means: ${KIND_MEANING[issue.kind]}

- URL: ${issue.url}
- Metric: ${issue.metric}
- Affected sessions: ${issue.affectedSessions.toLocaleString()} of ${issue.totalSessions.toLocaleString()} (${(issue.rate * 100).toFixed(1)}%)
${issue.trend ? `- Trend: ${issue.trend.direction}, ${(issue.trend.delta * 100).toFixed(2)}pp change over ${issue.trend.daysBetween} days` : "- Trend: no baseline yet"}

## Probe evidence (headless browser reproduction)

Primary probe, ${score.primary.kind}, score ${score.primary.score.toFixed(3)} (0 = clean, 1 = fully broken)
${score.primary.detail}

Evidence:
\`\`\`json
${JSON.stringify(score.primary.evidence, null, 2).slice(0, 4000)}
\`\`\`

Other probes on the same page (these are regression guards, a fix must not worsen them):
${Object.entries(score.regression)
  .map(([kind, r]) => `- ${kind}: ${r.score.toFixed(3)}, ${r.detail}`)
  .join("\n")}

## Task

Identify the root cause and propose up to 4 candidate fixes, ordered best first.`;

  return askStructured(Investigation, prompt, { system: SYSTEM, effort: "high" });
}
