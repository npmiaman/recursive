import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import * as git from "../git.ts";
import { Repo } from "../repo/git.ts";
import { classifyChange, describeBreakdown, type Area } from "../repo/areas.ts";
import {
  checkoutAreaBranch,
  cherryPick,
  commentOnPullRequest,
  hasRemote,
  push,
  upsertPullRequest,
} from "../repo/branch.ts";
import type { RunResult } from "./inner.ts";

/**
 * The ship stage.
 *
 * Fixes land on a long-lived branch per area of the system, `recursive/frontend`,
 * `recursive/backend`, `recursive/ml`, reused across runs rather than a new
 * branch per bug. One accumulating PR per area, reviewed by the people who own
 * that area, is how a team actually works. A PR per bug just buries them.
 *
 * The area can only be determined *after* the fix, from the files it touched, so
 * the hill-climb runs on the working branch and the accepted commits are
 * transplanted here.
 */

export interface ShippedFix {
  issueId: string;
  url: string;
  kind: string;
  area: Area;
  branch: string;
  prUrl?: string;
  prNumber?: number;
  shippedAt: string;
  clarityRateBefore: number;
  affectedSessionsBefore: number;
  probeBefore: number;
  probeAfter: number;
  commits: string[];
  verification?: {
    verifiedAt: string;
    clarityRateAfter: number;
    delta: number;
    verdict: "confirmed" | "no-change" | "regressed" | "inconclusive";
    note: string;
  };
}

function registryPath(): string {
  return resolve(config.dataDir, "shipped.jsonl");
}

export function recordShipped(fix: ShippedFix): void {
  mkdirSync(config.dataDir, { recursive: true });
  appendFileSync(registryPath(), JSON.stringify(fix) + "\n");
}

export function readShipped(): ShippedFix[] {
  const path = registryPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ShippedFix];
      } catch {
        return [];
      }
    });
}

export function writeShipped(all: ShippedFix[]): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(registryPath(), all.map((f) => JSON.stringify(f)).join("\n") + "\n");
}

function fixSummary(result: RunResult, area: Area, breakdown: string): string {
  const { issue, baseline, final, investigation } = result;
  return `### ${issue.kind} on \`${issue.url}\`

**Area:** ${area} (${breakdown})

| | |
|---|---|
| Sessions affected | ${issue.affectedSessions.toLocaleString()} of ${issue.totalSessions.toLocaleString()} (**${(issue.rate * 100).toFixed(1)}%**) |
| Severity | ${issue.severity.toFixed(0)}/100 |

**Root cause:** ${investigation.hypothesis}

**Measured effect:** probe score ${baseline.total.toFixed(4)} → ${final.total.toFixed(4)} (${result.improvement > 0 ? "−" : "+"}${Math.abs(result.improvement).toFixed(4)}; 0 = clean, 1 = fully broken).
${final.primary.detail}

Tried ${result.iterations.length} approach(es), kept ${result.acceptedCommits.length}. Every attempt was applied,
measured, and either committed or hard-reset, the keep-or-revert loop from
[karpathy/autoresearch](https://github.com/karpathy/autoresearch), with a headless-browser
probe standing in for \`val_bpb\`.`;
}

function prBody(result: RunResult, area: Area, breakdown: string): string {
  return `## Automated fixes, ${area}

This is a **long-lived branch**. Recursive appends fixes for the \`${area}\` area here as it
finds them, so this PR accumulates rather than fragmenting into one PR per bug. Each fix is
a separate commit and is described in a comment below.

---

${fixSummary(result, area, breakdown)}

---

⚠️ **The probe score is a proxy, not the goal.** Real telemetry is re-sampled
${config.verifyAfterDays} days after merge to confirm the failure actually stopped.
Run \`npm run cli -- verify\`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}

export interface ShipOptions {
  /** Create the branch and commits but skip push/PR. */
  dryRun?: boolean;
  onProgress?: (line: string) => void;
}

export async function ship(
  result: RunResult,
  options: ShipOptions = {},
): Promise<ShippedFix | undefined> {
  const log = options.onProgress ?? ((l: string) => console.log(l));

  if (result.acceptedCommits.length === 0) {
    log(" nothing to ship, no attempt improved the score.");
    return undefined;
  }
  if (!config.targetRepoPath) throw new Error("TARGET_REPO_PATH is not set.");

  const repoPath = config.targetRepoPath;
  const base = config.prBaseBranch;
  const originalBranch = git.currentBranch();

  // ---- Which area does this fix belong to? --------------------------------
  const repo = new Repo(repoPath);
  const changed = repo.changedBetween(result.startCommit, "HEAD").map((c) => c.path);
  const breakdown = classifyChange(changed);
  const area = breakdown.primary;

  log(` changed ${changed.length} file(s) → area '${area}' (${describeBreakdown(breakdown)})`);
  if (breakdown.crossCutting) {
    log(`  ⚠ change spans multiple areas, flagging for wider review`);
  }

  // ---- Get onto the area branch and transplant the commits ---------------
  let branchInfo;
  try {
    branchInfo = checkoutAreaBranch(area, { repoPath, base });
  } catch (error) {
    log(`  ! ${error instanceof Error ? error.message : error}`);
    git.checkout(originalBranch);
    return undefined;
  }

  log(
    ` branch ${branchInfo.branch}, ${branchInfo.created ? "created" : `reusing (${branchInfo.existingCommits} prior fix commit(s))`}` +
      (branchInfo.updatedFromBase ? `, updated from ${base}` : ""),
  );

  try {
    cherryPick(repoPath, result.acceptedCommits);
    log(` applied ${result.acceptedCommits.length} commit(s)`);
  } catch (error) {
    log(`  ! ${error instanceof Error ? error.message : error}`);
    git.checkout(originalBranch);
    return undefined;
  }

  const fix: ShippedFix = {
    issueId: result.issue.id,
    url: result.issue.url,
    kind: result.issue.kind,
    area,
    branch: branchInfo.branch,
    shippedAt: new Date().toISOString(),
    clarityRateBefore: result.issue.rate,
    affectedSessionsBefore: result.issue.affectedSessions,
    probeBefore: result.baseline.total,
    probeAfter: result.final.total,
    commits: result.acceptedCommits,
  };

  // ---- Push and open-or-update the area PR --------------------------------
  if (!options.dryRun) {
    if (!hasRemote(repoPath)) {
      log(` no 'origin' remote, commits are on ${branchInfo.branch} locally.`);
    } else {
      try {
        push(repoPath, branchInfo.branch);
        const pr = upsertPullRequest(
          repoPath,
          branchInfo.branch,
          base,
          `Recursive: automated fixes, ${area}`,
          prBody(result, area, describeBreakdown(breakdown)),
        );
        fix.prUrl = pr.url;
        fix.prNumber = pr.number;

        if (pr.created) {
          log(` opened PR #${pr.number}: ${pr.url}`);
        } else {
          // Existing PR already updated by the push; announce what was added.
          log(` updated existing PR #${pr.number}: ${pr.url}`);
          commentOnPullRequest(
            repoPath,
            pr.number,
            `### New fix appended\n\n${fixSummary(result, area, describeBreakdown(breakdown))}`,
          );
        }
      } catch (error) {
        log(`  ! could not push or open PR: ${error instanceof Error ? error.message : error}`);
        log(` commits are on ${branchInfo.branch}, push manually.`);
      }
    }
  } else {
    log(` dry run, not pushing. Inspect: git -C ${repoPath} log ${branchInfo.branch}`);
  }

  // ---- Leave the developer's branch exactly as we found it ---------------
  git.checkout(originalBranch);
  git.revertTo(result.startCommit);
  log(` restored ${originalBranch} to ${result.startCommit.slice(0, 8)}`);

  recordShipped(fix);
  return fix;
}
