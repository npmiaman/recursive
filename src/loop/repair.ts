import { randomUUID } from "node:crypto";
import { resolveFixer } from "../agents/fixers/index.ts";
import { Retriever, type RetrievedContext } from "../retrieve/index.ts";
import { classifyFile } from "../repo/areas.ts";
import { checkoutAreaBranch, push, upsertPullRequest, mergePullRequest, hasRemote } from "../repo/branch.ts";
import { Repo } from "../repo/git.ts";
import { append } from "../memory/store.ts";
import { recall } from "../memory/recall.ts";
import type { AttemptRecord, FailureRecord } from "../memory/types.ts";
import type { Flow, FlowManifest } from "../sweep/flows.ts";
import type { BackendVerification } from "../sweep/backend.ts";
import type { SweepEngine } from "../sweep/engine.ts";
import type { Diagnosis } from "./debug.ts";
import { runClosedLoop, formatClosedLoop, type ClosedLoopResult } from "./closed.ts";
import { Recorder, flushRuns } from "../session/recorder.ts";

/**
 * Tier 1 repair, the bridge that makes the closed loop executable.
 *
 * `closed.ts` owns the *policy*: try, verify against the real flow and the real
 * server, debug the failure, try again, and stop when it is fixed or when it is
 * honestly stuck. It deliberately knows nothing about how a change is made, it
 * takes an `applyChange` callback.
 *
 * This module supplies that callback, and everything around it:
 *
 *   - retrieval, so the coding agent starts in the right files
 *   - memory recall, so it does not re-run an approach already disproven
 *   - a long-lived per-area git branch, so fixes land where a human would put
 * them rather than on a throwaway branch per incident
 *   - a git checkpoint per cycle, so `revertChange` is a real undo and a cycle
 * that made things worse costs nothing
 *   - memory writes for every attempt INCLUDING the failures, which is the
 * record the next occurrence learns from
 *
 * The separation matters: the verification policy is the part that must not be
 * quietly weakened, and keeping it free of git and agent plumbing is what makes
 * it reviewable.
 */

export interface RepairOptions {
  projectId: string;
  repoPath: string;
  flow: Flow;
  manifest: FlowManifest;
  /** What the sweep saw. */
  failureSummary: string;
  transcript?: string;
  backend?: BackendVerification;
  maxCycles?: number;
  engine?: SweepEngine;
  headless?: boolean;
  /** Branch to base the area branch on and target the PR at. Default "main". */
  baseBranch?: string;
  /** Open/refresh a pull request when the repair verifies. Default true. */
  openPr?: boolean;
  /**
   * Auto-PR mode: merge the pull request as well, not just open it. Off by
   * default. This is the only step that lands a change without a human, so it is
   * opt-in and relies on the closed-loop verification plus repo branch
   * protection as its safety net.
   */
  autoMerge?: boolean;
  mergeMethod?: "squash" | "merge" | "rebase";
  /**
   * Files the agent may edit. Passed straight through to the coding agent to
   * stop a "fix" that deletes the feature instead of repairing it.
   */
  repairOnlyPaths?: string[];
  dryRun?: boolean;
  onProgress?: (line: string) => void;
}

export interface RepairResult {
  flowId: string;
  loop: ClosedLoopResult;
  branch?: string;
  prUrl?: string;
  /** True if auto-PR mode merged it. */
  merged?: boolean;
  /** Commits made across all cycles that were kept. */
  commits: string[];
}

/**
 * Turn a flow failure into the shape retrieval and memory already speak.
 *
 * The fingerprint is what makes recurrence detectable, so it must be stable
 * across runs: flow id plus route, NOT the summary text, which a model rewords
 * every time it sees the same defect.
 */
function failureRecordFor(options: RepairOptions, implicatedFiles: string[]): FailureRecord {
  return {
    type: "failure",
    id: randomUUID(),
    projectId: options.projectId,
    at: new Date().toISOString(),
    fingerprint: `flow:${options.flow.id}@${options.flow.url}`,
    signalClass: "flow-failure",
    route: options.flow.url,
    message: options.failureSummary,
    evidence: options.transcript,
    implicatedFiles,
  };
}

/** Coarsely classify a log line into a run stage, for the dashboard timeline. */
function stageFor(line: string): "retrieve" | "verify" | "ship" | "attempt" {
  const l = line.toLowerCase();
  if (l.includes("retriev") || l.includes("memory")) return "retrieve";
  if (l.includes("verif") || l.includes("flow") || l.includes("broken") || l.includes("passed"))
    return "verify";
  if (l.includes("branch") || l.includes("pr:") || l.includes("commit") || l.includes("merge"))
    return "ship";
  return "attempt";
}

export async function repairFlow(options: RepairOptions): Promise<RepairResult> {
  const repo = new Repo(options.repoPath);

  // Record everything this repair does, for the dashboard. Local-first and
  // best-effort: the recording never blocks or fails the repair.
  const recorder = new Recorder({
    kind: "repair",
    projectId: options.projectId,
    trigger: "manual",
    subject: { signalClass: "flow-failure" },
    repo: (() => {
      try {
        return { branch: repo.currentBranch() };
      } catch {
        return undefined;
      }
    })(),
  });
  const editedFiles = new Set<string>();

  const baseLog = options.onProgress ?? ((l: string) => console.log(l));
  const log = (line: string): void => {
    baseLog(line);
    recorder.event(stageFor(line), "info", line);
  };

  // ---- 1. Find the code ------------------------------------------------
  //
  // Once, up front. The relevant files do not change between cycle 2 and cycle
  // 3, only the theory about them does, and indexing is the expensive part.
  let context: RetrievedContext | undefined;
  try {
    const retriever = new Retriever(options.repoPath, options.projectId);
    const stats = retriever.build();
    if (stats.chunks > 0) {
      context = await retriever.retrieve({
        message: `${options.flow.name} is failing on ${options.flow.url}. ${options.failureSummary}`,
        route: options.flow.url,
        terms: options.flow.touches,
      });
      log(` retrieved ${context.chunks.length} chunk(s), ${context.reasoning[0] ?? ""}`);
    }
  } catch (error) {
    log(` retrieval unavailable: ${error instanceof Error ? error.message : error}`);
  }

  const implicatedFiles = [...new Set((context?.chunks ?? []).map((c) => c.chunk.path))];
  const failure = failureRecordFor(options, implicatedFiles);

  // ---- 2. Ask memory whether we have seen this before -------------------
  //
  // Before spending a single model call. If this exact defect recurred, memory
  // holds both the fix that worked and the approaches that did not, and the
  // second of those is what stops the loop wasting cycles re-deriving them.
  let memory: string | undefined;
  try {
    const recollection = recall({
      projectId: options.projectId,
      fingerprint: failure.fingerprint,
      signalClass: failure.signalClass,
      route: failure.route,
      message: failure.message,
      implicatedFiles,
      excludeFailureId: failure.id,
    });
    if (recollection.prompt) {
      memory = recollection.prompt;
      log(
        ` memory: ${recollection.cases.length} similar case(s), prior attempts will not be repeated`,
      );
    }
  } catch {
    /* memory not initialised for this project */
  }

  append(failure);

  // ---- 3. Pick the branch ----------------------------------------------
  //
  // Long-lived and per-area, the way a team actually works: all frontend
  // repairs accumulate on one branch and one PR rather than producing a branch
  // per incident that nobody reviews.
  // Base off the repo's ACTUAL default branch. Hardcoding "main" broke on every
  // repo that still defaults to "master" (and any team using a different trunk),
  // which `git checkout -b area main` fails on outright. The current branch at
  // the start of a repair is the trunk we want to branch from and target.
  const baseBranch = options.baseBranch ?? repo.currentBranch();

  let branch: string | undefined;
  if (!options.dryRun) {
    const area = classifyFile(implicatedFiles[0] ?? options.flow.touches[0] ?? "", {
      projectId: options.projectId,
    });
    const checkout = checkoutAreaBranch(area, {
      repoPath: options.repoPath,
      base: baseBranch,
    });
    branch = checkout.branch;
    log(` branch ${branch} (${checkout.created ? "created" : "reused"})`);
  }

  const fixer = resolveFixer();
  await fixer.preflight();

  const commits: string[] = [];
  /** Checkpoint taken before the current cycle's edit, for `revertChange`. */
  let checkpoint = repo.head();

  // ---- 4. Run the loop --------------------------------------------------
  const loop = await runClosedLoop({
    projectId: options.projectId,
    flow: options.flow,
    manifest: options.manifest,
    failure,
    context,
    maxCycles: options.maxCycles,
    engine: options.engine,
    headless: options.headless,
    onProgress: log,

    /**
     * Make one change. The diagnosis is the ONLY instruction, on cycle 1 it
     * comes from the initial investigation, on later cycles from the debugger,
     * which has already been forced to say why the previous theory was wrong.
     */
    applyChange: async (diagnosis: Diagnosis, cycle: number) => {
      checkpoint = repo.head();

      const attempt = await fixer.apply({
        // The coding agent's interface is shared with the Clarity path, so a
        // flow failure is presented in the same shape. The numbers are the
        // honest ones for a sweep: one flow, one failure, full severity, // a confirmed break of a critical journey is not a partial signal.
        issue: {
          id: `flow:${options.flow.id}`,
          url: options.flow.url,
          kind: "script-error",
          metric: "DeadClickCount",
          affectedSessions: 1,
          totalSessions: 1,
          rate: 1,
          severity: options.flow.critical ? 100 : 60,
          hypothesis: diagnosis.revisedHypothesis,
        },
        direction: {
          title: diagnosis.nextApproach.title,
          rationale: diagnosis.nextApproach.rationale,
          approach: [
            diagnosis.nextApproach.approach,
            options.repairOnlyPaths?.length
              ? `\nRepair the behaviour. Do NOT remove, hide, or feature-flag the feature off, it is a core journey and must keep working. Confine edits to: ${options.repairOnlyPaths.join(", ")}`
              : `\nRepair the behaviour. Do NOT remove, hide, or disable the feature to make the test pass.`,
          ].join("\n"),
          risk: diagnosis.nextApproach.risk,
          confidence: 0.6,
        },
        investigation: {
          hypothesis: diagnosis.revisedHypothesis,
          suspectSelectors: [],
          searchTerms: options.flow.touches,
          needsExternalResearch: false,
          directions: [],
        },
        attemptNumber: cycle,
        previousAttempts: [],
        repoPath: options.repoPath,
        context,
        memory,
      });

      // git is the ground truth, not the agent's own report. An engine that
      // says "done" while changing nothing is a failure mode already seen.
      const filesChanged = repo.dirtyFiles();
      const applied = filesChanged.length > 0;
      for (const f of filesChanged) editedFiles.add(f);

      if (applied && !options.dryRun) {
        repo.commitAll(
          `fix(${options.flow.id}): ${diagnosis.nextApproach.title}\n\n${diagnosis.revisedHypothesis}\n\nRecursive cycle ${cycle}. Not yet verified.`,
        );
        commits.push(repo.head());
      }

      // Record the attempt BEFORE knowing whether it worked. The outcome is
      // written by the loop; what matters here is that the reasoning is
      // captured even if the process dies mid-cycle.
      const record: AttemptRecord = {
        type: "attempt",
        id: randomUUID(),
        projectId: options.projectId,
        at: new Date().toISOString(),
        failureId: failure.id,
        attemptNumber: cycle,
        hypothesis: diagnosis.revisedHypothesis,
        approach: `${diagnosis.nextApproach.title}, ${diagnosis.nextApproach.approach}`,
        rationale: diagnosis.nextApproach.rationale,
        filesChanged,
        // The loop decides kept-vs-reverted after it verifies; a no-op is the
        // one outcome knowable right now, and worth recording because "the
        // agent did nothing" is itself a pattern worth spotting on recurrence.
        outcome: applied ? "kept" : "no-op",
        whyItFailed: diagnosis.whyPreviousAttemptFailed || undefined,
      };
      append(record);

      return { applied, summary: attempt.summary, filesChanged };
    },

    /**
     * Undo a cycle that made things worse.
     *
     * A hard reset to the pre-edit checkpoint, not a revert commit: the loop
     * may run several cycles and a chain of revert commits would make the final
     * PR unreadable. The reasoning is kept in memory either way, which is the
     * part that has lasting value.
     */
    revertChange: options.dryRun
      ? undefined
      : async () => {
          repo.resetHard(checkpoint);
          const undone = commits.pop();
          if (undone) log(` reverted ${undone.slice(0, 8)}`);
        },
  });

  log(formatClosedLoop(loop));

  // ---- 5. Ship it, if it verified ---------------------------------------
  //
  // Only on success, and only ever as a PR. Tier 1 stops at "a human has
  // something good to merge", auto-deploy is deliberately not in scope.
  let prUrl: string | undefined;
  let merged = false;
  if (loop.resolved && branch && commits.length && !options.dryRun && options.openPr !== false) {
    if (hasRemote(options.repoPath)) {
      push(options.repoPath, branch);
      const pr = upsertPullRequest(
        options.repoPath,
        branch,
        baseBranch,
        `Recursive: repair ${options.flow.name}`,
        [
          `**${options.flow.name}** was failing on \`${options.flow.url}\`.`,
          ``,
          options.failureSummary,
          ``,
          `### How it was verified`,
          `The user journey was re-run end to end after the change, and all three`,
          `independent checks passed: the flow completed in a real browser, the`,
          `business postconditions held, and the server showed no errors.`,
          ``,
          formatClosedLoop(loop),
        ].join("\n"),
      );
      prUrl = pr?.url;
      if (prUrl) log(`  PR: ${prUrl}`);

      // Auto-PR mode: merge it too. Off unless explicitly enabled, because this
      // is the step that lands an unreviewed change. The verification upstream
      // (real journey + postconditions + backend) is what makes it defensible;
      // branch protection on the repo is the backstop if it is not.
      if (options.autoMerge && pr) {
        const outcome = mergePullRequest(options.repoPath, pr.number, options.mergeMethod ?? "squash");
        merged = outcome.merged;
        log(`  ${outcome.note}`);
      }
    } else {
      log(` no git remote, commits are on ${branch}, push manually to open a PR`);
    }
  }

  // Close and upload the run. retrievalHitRank is computed in finish() from the
  // retrieved vs edited files, which is exactly the signal the Insights page
  // charts.
  recorder.finish(loop.resolved ? "succeeded" : "failed", {
    attemptsTried: loop.cycles.length,
    attemptsKept: commits.length,
    retrievedFiles: implicatedFiles,
    editedFiles: [...editedFiles],
    branch,
    prUrl,
    failureReason: loop.resolved ? undefined : loop.handoff?.reason,
  });
  await flushRuns().catch(() => {});

  return { flowId: options.flow.id, loop, branch, prUrl, merged, commits };
}
