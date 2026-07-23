import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "../config.ts";
import { describe, type Issue } from "../diagnose/issues.ts";
import { Scorer, formatScore, type Score } from "../score/index.ts";
import { askStructured } from "../agents/claude.ts";
import { investigate, type FixDirection, type Investigation } from "../agents/investigate.ts";
import { research } from "../agents/research.ts";
import { applyFix, retrieveContextFor } from "../agents/fix.ts";
import * as git from "../git.ts";
import { deriveLesson, recall, rememberAttempt, rememberFailure } from "../memory/recall.ts";
import { fingerprint as fingerprintOf } from "../detect/types.ts";
import { attemptsFor as memoryAttemptsFor } from "../memory/store.ts";

/**
 * The inner loop. AutoResearch applied to interface defects.
 *
 * Karpathy's loop is: read the training code, propose a change, run a 5-minute
 * job, measure one number, keep if it improved, revert if not, repeat. The only
 * substitution here is the metric: `val_bpb` becomes the composite probe score
 * from src/score, which is likewise a single number, likewise deterministic, and
 * likewise cheap enough to evaluate hundreds of times without a human present.
 *
 * Everything else is preserved, including the part that actually makes it work:
 * regressions are discarded, not argued with.
 */

/** Score must improve by at least this much to be kept. Guards against probe jitter. */
const MIN_IMPROVEMENT = 0.005;

/** Below this composite score the page is clean enough to stop working on it. */
const GOOD_ENOUGH = 0.05;

export interface Iteration {
  n: number;
  direction: string;
  risk: string;
  scoreBefore: number;
  scoreAfter: number | null;
  delta: number | null;
  outcome: "kept" | "reverted" | "no-op" | "error";
  note: string;
  at: string;
}

export interface RunResult {
  issue: Issue;
  investigation: Investigation;
  researchNotes?: string;
  baseline: Score;
  final: Score;
  improvement: number;
  iterations: Iteration[];
  acceptedCommits: string[];
  startCommit: string;
}

function journalPath(issueId: string): string {
  const safe = issueId.replace(/[^a-z0-9]+/gi, "_");
  return resolve(config.dataDir, "runs", `${safe}.jsonl`);
}

function journal(issueId: string, entry: unknown): void {
  mkdirSync(resolve(config.dataDir, "runs"), { recursive: true });
  appendFileSync(journalPath(issueId), JSON.stringify(entry) + "\n");
}

/**
 * When the investigator's pre-planned directions are exhausted, generate a new
 * one informed by what has already failed. This is what keeps the loop useful
 * past iteration 3, without it the run stalls once the obvious ideas are spent.
 */
const AlternativeDirection = z.object({
  title: z.string(),
  rationale: z.string(),
  approach: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
});

async function proposeAlternative(
  issue: Issue,
  investigation: Investigation,
  tried: { direction: string; scoreDelta: number }[],
  currentScore: Score,
): Promise<FixDirection> {
  const prompt = `A hill-climbing loop is trying to fix a measured UX defect and has run out of planned approaches.

## Defect
${describe(issue)}

## Root cause hypothesis
${investigation.hypothesis}

## Approaches already tried (every one was reverted for not improving the score)
${tried.map((t, i) => `${i + 1}. "${t.direction}" → score delta ${t.scoreDelta >= 0 ? "+" : ""}${t.scoreDelta.toFixed(4)}`).join("\n")}

## Current measurement
Composite score ${currentScore.total.toFixed(4)} (lower is better).
Primary probe (${currentScore.primary.kind}): ${currentScore.primary.score.toFixed(4)}, ${currentScore.primary.detail}
Evidence: ${JSON.stringify(currentScore.primary.evidence).slice(0, 1500)}

## Task
Propose ONE materially different approach. Do not restate a failed one. If the
evidence suggests the original hypothesis was wrong, say so in the rationale and
propose a fix for the cause you now believe is real.`;

  return askStructured(AlternativeDirection, prompt, {
    system:
      "You are a senior frontend engineer. Propose minimal, concrete fixes. " +
      "Prefer correcting semantics and interaction contracts over adding code.",
    effort: "high",
  });
}

function pickDirection(investigation: Investigation, index: number): FixDirection | undefined {
  const ordered = [...investigation.directions].sort((a, b) => b.confidence - a.confidence);
  return ordered[index];
}

export interface RunOptions {
  maxIterations?: number;
  /** Skip the external research stage even if the investigator asks for it. */
  skipResearch?: boolean;
  onProgress?: (line: string) => void;
}

export async function hillClimb(issue: Issue, options: RunOptions = {}): Promise<RunResult> {
  const maxIterations = options.maxIterations ?? config.maxIterations;
  const log = options.onProgress ?? ((line: string) => console.log(line));

  git.assertCleanRepo();
  const startCommit = git.checkpoint();

  const scorer = new Scorer();
  await scorer.open();

  try {
    log(`\n▶ ${describe(issue)}`);
    log(" measuring baseline…");
    const baseline = await scorer.score(issue);
    log(
      formatScore(baseline)
        .split("\n")
        .map((l) => "  " + l)
        .join("\n"),
    );

    journal(issue.id, { type: "baseline", issue, score: baseline, at: new Date().toISOString() });

    if (baseline.total <= GOOD_ENOUGH) {
      log(
        ` baseline already clean (${baseline.total.toFixed(4)}), the probe cannot reproduce this.`,
      );
      log(`  This usually means the Clarity signal is real but environment-specific`);
      log(`  (a device, locale, or auth state the probe isn't reproducing). Skipping.`);
      return {
        issue,
        investigation: {
          hypothesis: "Not reproducible in the probe environment.",
          suspectSelectors: [],
          searchTerms: [],
          needsExternalResearch: false,
          directions: [],
        },
        baseline,
        final: baseline,
        improvement: 0,
        iterations: [],
        acceptedCommits: [],
        startCommit,
      };
    }

    // What do we already know about this? Memory is consulted BEFORE the model
    // reasons from scratch, a disproven approach costs a whole iteration, and a
    // recurrence means the last fix didn't hold, which changes the strategy.
    const failureRecord = rememberFailure({
      projectId: "default",
      at: new Date().toISOString(),
      fingerprint: fingerprintOf({
        class: issue.kind as never,
        route: issue.url,
        message: `${issue.kind} on ${issue.url}`,
      }),
      signalClass: issue.kind,
      route: issue.url,
      message: `${issue.kind} on ${issue.url}, ${baseline.primary.detail}`,
      evidence: JSON.stringify(baseline.primary.evidence).slice(0, 4000),
      implicatedFiles: [],
      affectedSessions: issue.affectedSessions,
      severity: issue.severity,
    });

    const memory = recall({
      projectId: "default",
      fingerprint: failureRecord.fingerprint,
      signalClass: issue.kind,
      route: issue.url,
      message: failureRecord.message,
      implicatedFiles: [],
      excludeFailureId: failureRecord.id,
    });

    if (memory.cases.length) {
      log(` memory: ${memory.cases.length} similar past failure(s)`);
      if (memory.guidance.isRecurrence) {
        log(`    ⚠ this exact defect has occurred before, the earlier fix did not hold`);
      }
      if (memory.guidance.disproven.length) {
        log(`    ${memory.guidance.disproven.length} approach(es) already known not to work`);
      }
      if (memory.guidance.proven.length) {
        log(`    ${memory.guidance.proven.length} approach(es) that worked on similar failures`);
      }
    } else {
      log(` memory: nothing similar seen before, solving from scratch`);
    }

    log(" investigating root cause…");
    const investigation = await investigate(issue, baseline);
    log(` hypothesis: ${investigation.hypothesis}`);
    log(`  ${investigation.directions.length} candidate fix direction(s)`);

    let researchNotes: string | undefined;
    if (investigation.needsExternalResearch && !options.skipResearch) {
      log(" researching known issues…");
      researchNotes = await research(issue, investigation);
      log(` research: ${researchNotes.split("\n")[0]?.slice(0, 120) ?? "(no findings)"}`);
    }

    journal(issue.id, {
      type: "investigation",
      investigation,
      researchNotes,
      at: new Date().toISOString(),
    });

    // Retrieve once, reuse across every attempt, the repo index is the
    // expensive part and the relevant code doesn't change between attempts.
    log(" retrieving relevant code…");
    // Same project the memory writes below use, so retrieval reads from the
    // store this loop is populating.
    const context = await retrieveContextFor(issue, investigation, undefined, "default");
    if (context && context.chunks.length) {
      log(
        ` found ${context.chunks.length} chunk(s), ~${context.approxTokens} tokens` +
          (context.suspectCommit
            ? `; suspect commit ${context.suspectCommit.shortSha} "${context.suspectCommit.subject}"`
            : ""),
      );
      for (const line of context.reasoning) log(`    ${line}`);
    } else {
      log(" no code retrieved, the fix agent will search unaided");
    }

    let best = baseline;
    const iterations: Iteration[] = [];
    const acceptedCommits: string[] = [];
    const tried: { direction: string; scoreDelta: number }[] = [];

    for (let n = 1; n <= maxIterations; n++) {
      const direction =
        pickDirection(investigation, n - 1) ??
        (await proposeAlternative(issue, investigation, tried, best));

      log(`\n  [${n}/${maxIterations}] ${direction.title}  (risk: ${direction.risk})`);

      const checkpoint = git.checkpoint();
      const entry: Iteration = {
        n,
        direction: direction.title,
        risk: direction.risk,
        scoreBefore: best.total,
        scoreAfter: null,
        delta: null,
        outcome: "error",
        note: "",
        at: new Date().toISOString(),
      };

      try {
        const attempt = await applyFix(
          issue,
          direction,
          investigation,
          researchNotes,
          n,
          tried,
          undefined,
          context,
          memory.prompt,
        );

        if (!git.hasChanges()) {
          entry.outcome = "no-op";
          entry.note = attempt.summary.slice(0, 400) || "Agent made no edits.";
          log(` no changes made, ${entry.note.split("\n")[0]?.slice(0, 100)}`);
          git.revertTo(checkpoint);
          tried.push({ direction: direction.title, scoreDelta: 0 });
          iterations.push(entry);
          journal(issue.id, entry);
          continue;
        }

        log(` edited: ${git.diffStat().split("\n").pop() ?? "(unknown)"}`);
        log(` re-measuring…`);
        const after = await scorer.score(issue);
        const delta = after.total - best.total;

        entry.scoreAfter = after.total;
        entry.delta = delta;

        rememberAttempt({
          projectId: "default",
          at: new Date().toISOString(),
          failureId: failureRecord.id,
          attemptNumber: n,
          hypothesis: investigation.hypothesis,
          approach: direction.title,
          rationale: direction.rationale,
          filesChanged: git
            .diffStat()
            .split("\n")
            .slice(0, -1)
            .map((l) => l.trim().split(/\s+/)[0] ?? "")
            .filter(Boolean),
          scoreBefore: best.total,
          scoreAfter: after.total,
          outcome: delta < -MIN_IMPROVEMENT ? "kept" : "reverted",
          whyItFailed:
            delta < -MIN_IMPROVEMENT
              ? undefined
              : `probe score moved ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}, no improvement`,
        });

        if (delta < -MIN_IMPROVEMENT) {
          const commit = git.commitAll(
            `fix(ux): ${direction.title}\n\n` +
              `${issue.kind} on ${issue.url}\n` +
              `Probe score ${best.total.toFixed(4)} → ${after.total.toFixed(4)} (${delta.toFixed(4)})\n` +
              `Clarity: ${issue.affectedSessions} of ${issue.totalSessions} sessions affected.\n\n` +
              `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`,
          );
          acceptedCommits.push(commit);
          best = after;
          entry.outcome = "kept";
          entry.note = attempt.summary.slice(0, 600);
          log(
            `      ✓ KEPT   ${entry.scoreBefore.toFixed(4)} → ${after.total.toFixed(4)}  (${delta.toFixed(4)})`,
          );
        } else {
          git.revertTo(checkpoint);
          entry.outcome = "reverted";
          entry.note = attempt.summary.slice(0, 600);
          log(
            `      ✗ revert ${entry.scoreBefore.toFixed(4)} → ${after.total.toFixed(4)}  (${delta >= 0 ? "+" : ""}${delta.toFixed(4)})`,
          );
        }

        tried.push({ direction: direction.title, scoreDelta: delta });
      } catch (error) {
        // A failed attempt must never leave the tree dirty, the next iteration
        // depends on a clean checkpoint.
        git.revertTo(checkpoint);
        entry.outcome = "error";
        entry.note = error instanceof Error ? error.message : String(error);
        log(`      ! error: ${entry.note.slice(0, 200)}`);
        tried.push({ direction: direction.title, scoreDelta: 0 });
      }

      iterations.push(entry);
      journal(issue.id, entry);

      if (best.total <= GOOD_ENOUGH) {
        log(`\n target reached (${best.total.toFixed(4)} ≤ ${GOOD_ENOUGH}), stopping early.`);
        break;
      }
    }

    // A fix that held is a lesson worth keeping. Recorded only for the winning
    // attempt, recording every attempt as a lesson would drown recall in noise.
    const winning = iterations.filter((i) => i.outcome === "kept").pop();
    if (winning) {
      const attempts = memoryAttemptsFor("default", failureRecord.id);
      const winningAttempt = attempts.find((a) => a.attemptNumber === winning.n);
      if (winningAttempt) {
        deriveLesson({ projectId: "default", failure: failureRecord, winningAttempt });
      }
    }

    const improvement = baseline.total - best.total;
    log(
      `\n done: ${baseline.total.toFixed(4)} → ${best.total.toFixed(4)} ` +
        `(${improvement > 0 ? "-" : "+"}${Math.abs(improvement).toFixed(4)}), ` +
        `${acceptedCommits.length} change(s) kept of ${iterations.length} tried.`,
    );

    const result: RunResult = {
      issue,
      investigation,
      researchNotes,
      baseline,
      final: best,
      improvement,
      iterations,
      acceptedCommits,
      startCommit,
    };
    journal(issue.id, {
      type: "summary",
      improvement,
      kept: acceptedCommits.length,
      tried: iterations.length,
      at: new Date().toISOString(),
    });
    return result;
  } finally {
    await scorer.close();
  }
}
