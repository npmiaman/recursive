import { BrowserPool } from "../browse/pool.ts";
import { runFlowWithEngine, type SweepEngine } from "../sweep/engine.ts";
import { verifyBackend, type BackendVerification } from "../sweep/backend.ts";
import { captureBaselines, verify as verifyPostconditions } from "../sweep/verify.ts";
import type { Flow, FlowManifest } from "../sweep/flows.ts";
import { diagnoseFailedFix, type DebugEvidence, type Diagnosis } from "./debug.ts";
import { recall, rememberAttempt } from "../memory/recall.ts";
import type { RetrievedContext } from "../retrieve/index.ts";
import type { FailureRecord } from "../memory/types.ts";

/**
 * The closed loop.
 *
 * Recursive used to act and walk away, flip a flag, or open a PR, and wait days
 * for telemetry to say whether it helped. That is far too slow a feedback loop
 * to debug with, and it means a fix that didn't work sits there looking done.
 *
 * This closes it: after ANY change, drive the actual user flow again with the
 * browsing agent and find out immediately. If it is still broken, gather what
 * just happened as new evidence, work out why the last theory was wrong, and try
 * again, bounded, and stopping honestly when the evidence runs out.
 *
 * The critical property is that each cycle uses information the previous one did
 * not have. A loop that retries the same reasoning is not debugging, it is
 * thrashing, so a cycle that fails to change the hypothesis counts against the
 * budget twice.
 */

export interface CycleRecord {
  cycle: number;
  action: string;
  hypothesis: string;
  /** Did the real user flow pass afterwards? */
  flowPassed: boolean;
  flowSummary: string;
  backendClean: boolean;
  diagnosis?: Diagnosis;
  at: string;
}

export interface ClosedLoopResult {
  resolved: boolean;
  cycles: CycleRecord[];
  /** Why it stopped. */
  stoppedBecause: "verified" | "budget-exhausted" | "needs-human" | "no-progress";
  /** Everything gathered, for the human who picks it up. */
  handoff?: {
    reason: string;
    missingEvidence: string[];
    triedApproaches: string[];
  };
}

export interface ClosedLoopOptions {
  projectId: string;
  flow: Flow;
  manifest: FlowManifest;
  failure: FailureRecord;
  /** Applies one change and reports what it did. Returns false if it changed nothing. */
  applyChange: (
    diagnosis: Diagnosis,
    cycle: number,
  ) => Promise<{ applied: boolean; summary: string; filesChanged: string[] }>;
  /** Undo the last change, used when a cycle made things worse. */
  revertChange?: () => Promise<void>;
  context?: RetrievedContext;
  maxCycles?: number;
  engine?: SweepEngine;
  headless?: boolean;
  onProgress?: (line: string) => void;
}

/** Drive the real user flow and check both the UI and the server. */
async function verifyFlow(
  flow: Flow,
  manifest: FlowManifest,
  pool: BrowserPool,
  engine: SweepEngine,
): Promise<{ passed: boolean; summary: string; transcript: string; backend: BackendVerification }> {
  const conditions = flow.verify ?? [];
  const baselines = await captureBaselines(conditions);
  const windowStart = new Date().toISOString();

  const result = await runFlowWithEngine(flow, {
    engine,
    pool,
    baseUrl: manifest.baseUrl,
    // Never replay a recorded trace here. The trace describes the app as it was
    // BEFORE the fix; replaying it would either follow a path that no longer
    // exists or, worse, pass by luck without exercising the change.
    noReplay: true,
  });

  const postconditions = await verifyPostconditions(
    conditions,
    baselines,
    result.status === "passed",
  );

  const backend = await verifyBackend({
    flowId: flow.id,
    traceUrl: manifest.backendTraceUrl,
    token: manifest.backendTokenEnv ? process.env[manifest.backendTokenEnv] : undefined,
    since: windowStart,
    uiPassed: result.status === "passed",
  });

  return {
    // Three independent judges must all agree before we call it fixed: the user
    // journey completed, the business assertions hold, and the server behaved.
    passed: result.status === "passed" && postconditions.passed && !backend.failed,
    summary: result.summary,
    transcript: result.transcript,
    backend,
  };
}

export async function runClosedLoop(options: ClosedLoopOptions): Promise<ClosedLoopResult> {
  const log = options.onProgress ?? ((l: string) => console.log(l));
  const maxCycles = options.maxCycles ?? 4;
  const engine = options.engine ?? "internal";

  const pool = new BrowserPool({ headless: options.headless !== false });
  await pool.start();

  const cycles: CycleRecord[] = [];
  const attempts: DebugEvidence["attempts"] = [];

  // Memory is consulted once up front, it does not change between cycles, and
  // re-querying it every time would just cost latency.
  const memory = recall({
    projectId: options.projectId,
    fingerprint: options.failure.fingerprint,
    signalClass: options.failure.signalClass,
    route: options.failure.route,
    message: options.failure.message,
    implicatedFiles: options.failure.implicatedFiles,
    excludeFailureId: options.failure.id,
  });

  try {
    // ---- Cycle 0: is it even still broken? ------------------------------
    log(`\n verifying the flow before changing anything…`);
    let current = await verifyFlow(options.flow, options.manifest, pool, engine);

    if (current.passed) {
      log(`  ✓ the flow already passes, nothing to fix`);
      return { resolved: true, cycles, stoppedBecause: "verified" };
    }
    log(`  ✗ confirmed broken: ${current.summary}`);

    let lastHypothesis = "";
    let unchangedHypothesisCount = 0;

    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      log(`\n  ── cycle ${cycle}/${maxCycles} ──`);

      // ---- Work out what to do, using everything we now know ------------
      const diagnosis = await diagnoseFailedFix({
        failure: {
          kind: options.failure.signalClass,
          route: options.failure.route,
          message: options.failure.message,
        },
        attempts,
        context: options.context,
        memory: memory.prompt,
        backend: current.backend,
      });

      log(` why the last attempt failed: ${diagnosis.whyPreviousAttemptFailed.slice(0, 160)}`);
      log(` revised theory: ${diagnosis.revisedHypothesis.slice(0, 160)}`);

      if (diagnosis.needsHuman) {
        log(
          `  ⚠ stopping, ${diagnosis.needsHumanReason ?? "the evidence does not support a confident next step"}`,
        );
        return {
          resolved: false,
          cycles,
          stoppedBecause: "needs-human",
          handoff: {
            reason: diagnosis.needsHumanReason ?? "insufficient evidence",
            missingEvidence: diagnosis.missingEvidence,
            triedApproaches: attempts.map((a) => a.approach),
          },
        };
      }

      // A loop that keeps proposing the same theory is thrashing, not debugging.
      if (!diagnosis.hypothesisChanged && diagnosis.revisedHypothesis === lastHypothesis) {
        unchangedHypothesisCount++;
        if (unchangedHypothesisCount >= 2) {
          log(
            `  ⚠ stopping, the theory has not changed in two cycles; more attempts would just be variations`,
          );
          return {
            resolved: false,
            cycles,
            stoppedBecause: "no-progress",
            handoff: {
              reason: "The diagnosis stopped changing while the flow stayed broken.",
              missingEvidence: diagnosis.missingEvidence,
              triedApproaches: attempts.map((a) => a.approach),
            },
          };
        }
      } else {
        unchangedHypothesisCount = 0;
      }
      lastHypothesis = diagnosis.revisedHypothesis;

      // ---- Apply the change ---------------------------------------------
      log(` applying: ${diagnosis.nextApproach.title}`);
      const change = await options.applyChange(diagnosis, cycle);

      if (!change.applied) {
        log(` no change was made, ${change.summary.slice(0, 120)}`);
        attempts.push({
          n: cycle,
          approach: diagnosis.nextApproach.title,
          hypothesis: diagnosis.revisedHypothesis,
          filesChanged: [],
          whyRejected: "the agent did not make any edit",
        });
        continue;
      }

      // ---- Did it actually work? -----------------------------------------
      log(` re-running the real user flow…`);
      const after = await verifyFlow(options.flow, options.manifest, pool, engine);

      const record: CycleRecord = {
        cycle,
        action: diagnosis.nextApproach.title,
        hypothesis: diagnosis.revisedHypothesis,
        flowPassed: after.passed,
        flowSummary: after.summary,
        backendClean: !after.backend.failed,
        diagnosis,
        at: new Date().toISOString(),
      };
      cycles.push(record);

      rememberAttempt({
        projectId: options.projectId,
        at: new Date().toISOString(),
        failureId: options.failure.id,
        attemptNumber: cycle,
        hypothesis: diagnosis.revisedHypothesis,
        approach: diagnosis.nextApproach.title,
        rationale: diagnosis.nextApproach.rationale,
        filesChanged: change.filesChanged,
        outcome: after.passed ? "kept" : "reverted",
        whyItFailed: after.passed ? undefined : after.summary,
      });

      if (after.passed) {
        log(`  ✓ VERIFIED, the user flow now completes, assertions hold, server is clean`);
        return { resolved: true, cycles, stoppedBecause: "verified" };
      }

      log(`  ✗ still broken: ${after.summary.slice(0, 160)}`);

      // Undo it. A change that didn't fix the problem is noise in the diff, and
      // leaving several of them stacked makes the next diagnosis harder.
      if (options.revertChange) {
        await options.revertChange();
        log(` reverted`);
      }

      attempts.push({
        n: cycle,
        approach: diagnosis.nextApproach.title,
        hypothesis: diagnosis.revisedHypothesis,
        filesChanged: change.filesChanged,
        flowTranscript: after.transcript,
        backendFindings: after.backend.findings.map((f) => `${f.title}: ${f.detail}`),
        whyRejected: after.summary,
      });

      current = after;
    }

    log(`\n  ⚠ exhausted ${maxCycles} cycles without fixing it`);
    return {
      resolved: false,
      cycles,
      stoppedBecause: "budget-exhausted",
      handoff: {
        reason: `Tried ${maxCycles} approaches; the flow still fails.`,
        missingEvidence: [],
        triedApproaches: attempts.map((a) => a.approach),
      },
    };
  } finally {
    await pool.stop();
  }
}

/** Render the loop for a PR body or a human handoff. */
export function formatClosedLoop(result: ClosedLoopResult): string {
  const lines: string[] = [];

  lines.push(
    result.resolved
      ? `**Verified fixed** after ${result.cycles.length} cycle(s), the real user flow was re-run and passed.`
      : `**Not fixed** after ${result.cycles.length} cycle(s), stopped because: ${result.stoppedBecause}.`,
  );
  lines.push("");

  for (const cycle of result.cycles) {
    lines.push(`### Cycle ${cycle.cycle}: ${cycle.action}`);
    lines.push(`- Theory: ${cycle.hypothesis}`);
    lines.push(`- Flow re-run: ${cycle.flowPassed ? "✅ passed" : "❌ " + cycle.flowSummary}`);
    lines.push(`- Server: ${cycle.backendClean ? "clean" : "errors during the run"}`);
    if (cycle.diagnosis?.whyPreviousAttemptFailed) {
      lines.push(`- Why the previous attempt failed: ${cycle.diagnosis.whyPreviousAttemptFailed}`);
    }
    lines.push("");
  }

  if (result.handoff) {
    lines.push(`### Handing over to a human`);
    lines.push(result.handoff.reason);
    if (result.handoff.triedApproaches.length) {
      lines.push(`\nAlready tried (all reverted):`);
      for (const approach of result.handoff.triedApproaches) lines.push(`- ${approach}`);
    }
    if (result.handoff.missingEvidence.length) {
      lines.push(`\nWhat would settle it:`);
      for (const item of result.handoff.missingEvidence) lines.push(`- ${item}`);
    }
  }

  return lines.join("\n");
}
