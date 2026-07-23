import { z } from "zod";
import { resolveProvider } from "../llm/provider.ts";
import type { Chunk } from "./chunk.ts";

/**
 * Query expansion and reranking.
 *
 * These are the two techniques that move retrieval quality most, and neither is
 * a scoring tweak, which is why the earlier round of fixes (tuning constants,
 * excluding hubs) only got so far. Formulas can reorder candidates; they cannot
 * *understand* them.
 *
 * QUERY EXPANSION runs before searching. A failure reads "Place Order button
 * does nothing"; the code says `submitOrder`, `CheckoutButton`, `useOrder`.
 * There is no word overlap at all, so no amount of word-frequency tuning finds
 * it. Asking a model "what would this be called in code?" bridges that gap, and
 * does it without needing an embedding service.
 *
 * RERANKING runs after searching. Cheap retrieval is good at recall and bad at
 * precision, the right answer is usually in the top 30, rarely reliably at #1.
 * Having a model read those 30 and pick the relevant ones is the standard
 * retrieve-then-rerank pattern, and it beats every scoring formula because it
 * actually reads the code.
 *
 * Both are optional. Retrieval works without them; it is simply better with them.
 */

const Expansion = z.object({
  identifiers: z
    .array(z.string())
    .describe(
      "Likely function, component, variable or class names in the codebase. camelCase/PascalCase.",
    ),
  filenames: z
    .array(z.string())
    .describe("Likely file or directory name fragments, e.g. 'checkout', 'OrderButton'."),
  concepts: z
    .array(z.string())
    .describe("Domain terms likely to appear in comments or strings near the cause."),
});

export type Expansion = z.infer<typeof Expansion>;

/**
 * Translate a human failure description into the vocabulary the code uses.
 * Cheap (one small call), and it runs once per hill-climb rather than per attempt.
 */
export async function expandQuery(input: {
  description: string;
  route?: string;
  selector?: string;
  /** A sample of real paths, so guesses match this repo's conventions. */
  samplePaths: string[];
}): Promise<Expansion | undefined> {
  const prompt = `A failure was observed in a codebase. Predict the vocabulary the code itself would use,
so a keyword search can find it.

## Failure
${input.description}
${input.route ? `Route: ${input.route}` : ""}
${input.selector ? `DOM selector: ${input.selector}` : ""}

## Files in this repository (sample, to match naming conventions)
${input.samplePaths
  .slice(0, 60)
  .map((p) => `- ${p}`)
  .join("\n")}

## Task
List the identifiers, filename fragments and domain terms most likely to appear in the
responsible code. Be specific and match the conventions visible above. Do not restate the
failure text, the point is to produce terms that are NOT in it.`;

  try {
    return await resolveProvider().structured(Expansion, prompt, {
      // Cheap, bounded, and one of several signals, depth here is wasted.
      effort: "low",
      maxTokens: 2000,
      system: "You predict code vocabulary from failure descriptions. Answer concisely.",
    });
  } catch {
    // Expansion is an accelerator. Losing it costs recall, not correctness.
    return undefined;
  }
}

const Judgement = z.object({
  relevant: z
    .array(
      z.object({
        index: z.number().describe("The candidate's number as shown."),
        reason: z.string().describe("One short clause on why it matters."),
      }),
    )
    .describe("Candidates genuinely relevant to fixing this failure, most relevant first."),
});

export interface RerankResult {
  /** Indices into the input array, most relevant first. */
  order: number[];
  reasons: Map<number, string>;
}

/**
 * Have a model read the shortlist and pick what's actually relevant.
 *
 * Only the top N candidates are shown, and only a slice of each, the goal is a
 * fast relevance judgement, not a code review. A candidate the model omits isn't
 * deleted, just demoted, so a wrong call degrades the ordering rather than
 * losing the answer.
 */
export async function rerank(
  failureDescription: string,
  candidates: Chunk[],
  limit = 30,
): Promise<RerankResult | undefined> {
  if (candidates.length <= 3) return undefined; // nothing meaningful to reorder

  const shortlist = candidates.slice(0, limit);

  const rendered = shortlist
    .map((chunk, i) => {
      // Enough to judge relevance, not enough to blow the context budget.
      const excerpt = chunk.text.split("\n").slice(0, 25).join("\n");
      return `### [${i}] ${chunk.path}:${chunk.startLine}-${chunk.endLine}${chunk.symbol ? ` (${chunk.symbol})` : ""}
\`\`\`
${excerpt}
\`\`\``;
    })
    .join("\n\n");

  const prompt = `## Failure
${failureDescription}

## Candidate code
${rendered}

## Task
Which candidates are genuinely relevant to diagnosing and fixing this failure?

Include a candidate only if it plausibly contains the cause, or is needed to understand it
(the caller, the shared helper, the type definition). Exclude anything that merely shares
vocabulary, matching words is not relevance. Returning three precise candidates is far more
useful than fifteen loose ones. If none are relevant, return an empty list.`;

  try {
    const judgement = await resolveProvider().structured(Judgement, prompt, {
      effort: "medium",
      maxTokens: 4000,
      system:
        "You rank code by relevance to a specific failure. You are precise and you " +
        "exclude aggressively, a short accurate list beats a long plausible one.",
    });

    const order: number[] = [];
    const reasons = new Map<number, string>();
    for (const entry of judgement.relevant) {
      if (entry.index >= 0 && entry.index < shortlist.length && !order.includes(entry.index)) {
        order.push(entry.index);
        reasons.set(entry.index, entry.reason);
      }
    }
    return { order, reasons };
  } catch {
    return undefined;
  }
}
