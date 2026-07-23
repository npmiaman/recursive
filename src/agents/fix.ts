import { config } from "../config.ts";
import type { Issue } from "../diagnose/issues.ts";
import { Retriever, type RetrievedContext } from "../retrieve/index.ts";
import { resolveFixer, type FixAttempt, type FixEngine } from "./fixers/index.ts";
import type { FixDirection, Investigation } from "./investigate.ts";

export type { FixAttempt } from "./fixers/index.ts";

/**
 * The fix stage, engine-agnostic entry point.
 *
 * This used to call the Claude Agent SDK directly. It now resolves an engine,
 * because Recursive edits code in *customers'* repositories and they do not all
 * have the same constraints: some need the best available quality, some cannot
 * let a single prompt leave their network. See src/agents/fixers/.
 *
 * Everything downstream is unchanged and deliberately so, the git checkpoint,
 * the probe measurement, and the keep-or-revert decision behave identically
 * regardless of which engine produced the edit. That is what makes swapping
 * engines a configuration change rather than a rewrite, and what makes it
 * possible to compare two engines on the same issue.
 */
export async function applyFix(
  issue: Issue,
  direction: FixDirection,
  investigation: Investigation,
  researchNotes: string | undefined,
  attemptNumber: number,
  previousAttempts: { direction: string; scoreDelta: number }[],
  engine?: FixEngine,
  context?: RetrievedContext,
  memory?: string,
): Promise<FixAttempt> {
  if (!config.targetRepoPath) {
    throw new Error("TARGET_REPO_PATH is not set, nowhere to apply the fix.");
  }

  const fixer = resolveFixer(engine);
  await fixer.preflight();

  return fixer.apply({
    issue,
    direction,
    investigation,
    researchNotes,
    attemptNumber,
    previousAttempts,
    repoPath: config.targetRepoPath,
    context,
    memory,
  });
}

/**
 * Retrieve the code relevant to an issue, once per hill-climb run.
 *
 * Deliberately hoisted out of the per-attempt path: indexing a repository is the
 * expensive part, and the relevant code does not change between attempt 3 and
 * attempt 4, only the approach does.
 */
export async function retrieveContextFor(
  issue: Issue,
  investigation: Investigation,
  firstSeen?: Date,
  projectId?: string,
): Promise<RetrievedContext | undefined> {
  if (!config.targetRepoPath) return undefined;

  try {
    const retriever = new Retriever(config.targetRepoPath, projectId);
    const stats = retriever.build();
    if (stats.chunks === 0) return undefined;

    return await retriever.retrieve({
      message: `${issue.kind} on ${issue.url}. ${investigation.hypothesis}`,
      selector: investigation.suspectSelectors[0],
      route: issue.url,
      terms: investigation.searchTerms,
      failedAt: firstSeen,
    });
  } catch (error) {
    // Retrieval is an accelerator, not a dependency. If it fails the agent can
    // still find the code itself, degrade rather than abort the run.
    console.warn(
      `[retrieve] unavailable (${error instanceof Error ? error.message : error}); ` +
        `the fix agent will search unaided.`,
    );
    return undefined;
  }
}
