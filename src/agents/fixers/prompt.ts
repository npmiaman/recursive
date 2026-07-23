import { KIND_MEANING } from "../../diagnose/issues.ts";
import { programSection } from "../../program.ts";
import { formatContext } from "../../retrieve/index.ts";
import type { FixRequest } from "./types.ts";

/**
 * The fix instructions, shared by every engine.
 *
 * Kept engine-agnostic on purpose: if the prompt differed per engine, a
 * difference in output could never be attributed to the engine itself, and the
 * whole point of making this swappable is being able to compare them.
 */

export const FIX_SYSTEM = `You are fixing a specific, measured UX defect in this repository.

Hard constraints:
- Make the SMALLEST change that addresses the stated cause. No refactors, no new
 abstractions, no reformatting of untouched code, no "while I'm here" cleanups.
- Do not modify tests to make anything pass. Do not touch CI config.
- Do not install dependencies or change lockfiles unless the fix is impossible
 without it, and if so, say why in your summary.
- Match the surrounding code's conventions exactly: same component patterns,
 same styling approach, same naming.
- If you cannot locate the responsible code with reasonable confidence, STOP and
 say so plainly. A truthful "not found" is far more useful here than a plausible
 edit to the wrong file, an automated loop will measure and ship whatever you do.

Finish with a one-paragraph summary naming each file you changed and what changed
in it.`;

export function buildFixPrompt(request: FixRequest): string {
  const { issue, direction, investigation, researchNotes, attemptNumber, previousAttempts } =
    request;

  const history = previousAttempts.length
    ? `\n## Previous attempts on this issue (all reverted)\n\n${previousAttempts
        .map(
          (a, i) =>
            `${i + 1}. "${a.direction}" → score moved ${a.scoreDelta >= 0 ? "+" : ""}${a.scoreDelta.toFixed(4)} (${a.scoreDelta >= 0 ? "worse or no better" : "better"})`,
        )
        .join(
          "\n",
        )}\n\nDo not repeat an approach that already failed. Try something materially different.\n`
    : "";

  // Retrieved code, when the caller ran retrieval. This is what turns the fix
  // stage from "go find it yourself with grep" into "here is the code, and here
  // is the commit that most likely broke it", which is both faster and much
  // less likely to land an edit in the wrong file.
  const retrieved = request.context ? formatContext(request.context) : "";

  return `# Fix a measured defect
${programSection()}
## The defect

Real user sessions show **${issue.kind}** on \`${issue.url}\`, affecting
${issue.affectedSessions.toLocaleString()} of ${issue.totalSessions.toLocaleString()} sessions (${(issue.rate * 100).toFixed(1)}%).

${KIND_MEANING[issue.kind]}

## Root cause (from analysis of headless-browser probe evidence)

${investigation.hypothesis}

${investigation.suspectSelectors.length ? `Suspect selectors:\n${investigation.suspectSelectors.map((s) => `- \`${s}\``).join("\n")}\n` : ""}
${retrieved}
${retrieved ? "The code above was retrieved automatically and is a strong starting point, but it is not guaranteed complete, read further if the fix isn't there.\n" : investigation.searchTerms.length ? `Try grepping this repo for: ${investigation.searchTerms.map((t) => `\`${t}\``).join(", ")}\n` : ""}
${request.memory ? request.memory + "\n" : ""}
${researchNotes ? `## External research findings\n\n${researchNotes}\n` : ""}${history}
## The fix to implement (attempt ${attemptNumber})

**${direction.title}** (risk: ${direction.risk})

${direction.rationale}

Approach: ${direction.approach}

## Task

Locate the responsible code and implement exactly this fix. Then summarise what you changed.`;
}
