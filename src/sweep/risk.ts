import { Repo } from "../repo/git.ts";
import { flowOwnsFile, journeyFilesFor, type Flow } from "./flows.ts";

/**
 * Which flows are most likely to be broken right now?
 *
 * "Test the things most likely to fail" needs an actual model, or it collapses
 * into "test whatever someone remembered to mark important". Every input here is
 * already available, git history and our own sweep records, so this costs
 * nothing to compute and improves as the system runs.
 *
 * The four signals, in rough order of predictive value:
 *   1. Recently changed, the strongest predictor by a distance. Code that just
 * changed is where regressions are.
 *   2. Previously failed, a flow that broke once breaks again; fixes are often
 * incomplete.
 *   3. High churn, files edited constantly accumulate defects.
 *   4. Long untested, absence of evidence, not evidence of absence.
 */

export interface FlowHistory {
  flowId: string;
  lastTestedAt?: string;
  lastFailedAt?: string;
  /** Failures in the last 30 days. */
  recentFailures: number;
  totalRuns: number;
}

export interface RiskScore {
  flow: Flow;
  /** 0..100. */
  score: number;
  /** Plain-language account of why, shown in the sweep plan. */
  factors: string[];
}

export interface RiskInputs {
  flows: Flow[];
  repoPath: string;
  history: Map<string, FlowHistory>;
  /** Files changed recently, from the PR, or from the last day of commits. */
  recentlyChanged?: string[];
  /** Enables base memory's flow→file mapping. Without it, `touches` alone. */
  projectId?: string;
}

export function scoreFlows(inputs: RiskInputs): RiskScore[] {
  let churn = new Map<string, number>();
  try {
    churn = new Repo(inputs.repoPath).churn(30);
  } catch {
    // Not a git repo, or git unavailable, the other signals still work.
  }

  const scored = inputs.flows.map((flow) => {
    const factors: string[] = [];
    let score = 0;

    // What base memory says this flow's code is, alongside the manifest's
    // `touches`. Without this, a flow whose files moved scores as untouched
    // even while the sweep correctly selects it, it then ranks last and can
    // fall off the `--max` cutoff, which is the worst possible failure mode:
    // silently testing less than you think you are.
    const journeyFiles = journeyFilesFor(flow, inputs.projectId);

    // 1. Critical flows carry a floor. A broken checkout matters even on a quiet
    // week with no changes anywhere near it.
    if (flow.critical) {
      score += 30;
      factors.push("core flow (+30)");
    }

    // 2. Recently changed, the strongest signal.
    if (inputs.recentlyChanged?.length) {
      const touched = inputs.recentlyChanged.filter((file) =>
        flowOwnsFile(flow, file, journeyFiles),
      );
      if (touched.length) {
        const points = Math.min(35, 15 + touched.length * 5);
        score += points;
        factors.push(
          `${touched.length} file(s) changed recently: ${touched.slice(0, 3).join(", ")} (+${points})`,
        );
      }
    }

    // 3. Failure history. A flow that has broken before is more likely to break
    // again, incomplete fixes are the norm, not the exception.
    const history = inputs.history.get(flow.id);
    if (history?.recentFailures) {
      const points = Math.min(25, history.recentFailures * 10);
      score += points;
      factors.push(`failed ${history.recentFailures}× in the last 30d (+${points})`);
    }

    // 4. Churn in the files it depends on.
    let flowChurn = 0;
    for (const [path, count] of churn) {
      if (flowOwnsFile(flow, path, journeyFiles)) flowChurn += count;
    }
    if (flowChurn > 0) {
      const points = Math.min(15, Math.round(flowChurn * 1.5));
      score += points;
      factors.push(`${flowChurn} commit(s) touched its code in 30d (+${points})`);
    }

    // 5. Staleness. Not evidence of breakage, but the longer since we looked the
    // less we know, so it breaks ties rather than driving the ranking.
    if (!history?.lastTestedAt) {
      score += 10;
      factors.push("never tested (+10)");
    } else {
      const days = (Date.now() - Date.parse(history.lastTestedAt)) / 86_400_000;
      if (days > 7) {
        const points = Math.min(10, Math.round(days / 3));
        score += points;
        factors.push(`not tested for ${Math.round(days)}d (+${points})`);
      }
    }

    return { flow, score: Math.min(100, score), factors };
  });

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Choose what a daily sweep actually runs.
 *
 * Every critical flow, always: that's what "core feature" means, and skipping
 * one because it looks quiet is how you find out at 9am on a Monday. Then the
 * highest-risk remainder up to the budget, because a sweep nobody can afford to
 * run daily is a sweep that stops running.
 */
export function selectForDailySweep(scored: RiskScore[], maxFlows = 12): RiskScore[] {
  const critical = scored.filter((s) => s.flow.critical);
  const rest = scored.filter((s) => !s.flow.critical);
  return [...critical, ...rest.slice(0, Math.max(0, maxFlows - critical.length))];
}
