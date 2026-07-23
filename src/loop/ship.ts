import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import * as git from "../git.ts";
import type { RunResult } from "./inner.ts";

/**
 * The PR stage, plus the shipped-fix registry the outer verification loop reads.
 *
 * The registry is what closes the loop. Without a durable record of "this PR
 * claimed to fix this issue on this date, and the probe score moved this much",
 * there is no way to later ask Clarity whether the claim was true.
 */

export interface ShippedFix {
  issueId: string;
  url: string;
  kind: string;
  branch: string;
  prUrl?: string;
  shippedAt: string;
  /** Clarity friction rate at the time of shipping — the number we expect to fall. */
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

/** Rewrite the registry in place — used when verification results are attached. */
export function writeShipped(all: ShippedFix[]): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(registryPath(), all.map((f) => JSON.stringify(f)).join("\n") + "\n");
}

function slug(input: string): string {
  return input.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 40);
}

function prBody(result: RunResult): string {
  const { issue, baseline, final, investigation, iterations, researchNotes } = result;

  const kept = iterations.filter((i) => i.outcome === "kept");
  const rejected = iterations.filter((i) => i.outcome === "reverted");

  return `## What this fixes

Microsoft Clarity measured **${issue.kind}** on \`${issue.url}\` across real sessions:

| | |
|---|---|
| Sessions affected | ${issue.affectedSessions.toLocaleString()} of ${issue.totalSessions.toLocaleString()} (**${(issue.rate * 100).toFixed(1)}%**) |
| Severity | ${issue.severity.toFixed(0)}/100 |
| Trend | ${issue.trend ? `${issue.trend.direction} (${issue.trend.delta >= 0 ? "+" : ""}${(issue.trend.delta * 100).toFixed(2)}pp over ${issue.trend.daysBetween}d)` : "no baseline yet"} |

## Root cause

${investigation.hypothesis}

## Measured effect

A headless-browser probe reproduced the defect and scored it before and after
(0 = clean, 1 = fully broken; the score blends the target metric with the other
five as a regression guard):

**${baseline.total.toFixed(4)} → ${final.total.toFixed(4)}** (${result.improvement > 0 ? "−" : "+"}${Math.abs(result.improvement).toFixed(4)})

- Primary probe (\`${final.primary.kind}\`): ${baseline.primary.score.toFixed(4)} → ${final.primary.score.toFixed(4)}
- ${final.primary.detail}

## How this was produced

An autonomous hill-climb tried ${iterations.length} approach(es) and kept ${kept.length}.
Each attempt was applied, measured, and either committed or hard-reset — the same
keep-or-revert loop as [karpathy/autoresearch](https://github.com/karpathy/autoresearch),
with the probe score standing in for \`val_bpb\`.

**Kept:**
${kept.map((i) => `- ${i.direction} (${i.scoreBefore.toFixed(4)} → ${i.scoreAfter?.toFixed(4)})`).join("\n") || "- (none)"}

${rejected.length ? `**Tried and reverted:**\n${rejected.map((i) => `- ${i.direction} (${i.delta !== null && i.delta >= 0 ? "+" : ""}${i.delta?.toFixed(4)})`).join("\n")}` : ""}

${researchNotes ? `<details><summary>External research</summary>\n\n${researchNotes}\n\n</details>` : ""}

---

⚠️ **The probe score is a proxy, not the goal.** Clarity will be re-sampled
${config.verifyAfterDays} days after this merges to confirm the real
\`${issue.metric}\` actually fell. Run \`npm run verify\` to check.

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}

export interface ShipOptions {
  /** Create the branch and commits but skip push/PR. */
  dryRun?: boolean;
  onProgress?: (line: string) => void;
}

/**
 * Move the accepted commits onto their own branch, open a PR, and restore the
 * original branch to exactly where it started.
 */
export async function ship(result: RunResult, options: ShipOptions = {}): Promise<ShippedFix | undefined> {
  const log = options.onProgress ?? ((l: string) => console.log(l));

  if (result.acceptedCommits.length === 0) {
    log("  nothing to ship — no attempt improved the score.");
    return undefined;
  }

  const originalBranch = git.currentBranch();
  const stamp = new Date().toISOString().slice(0, 10);
  const branch = `ux/${result.issue.kind}-${slug(result.issue.url)}-${stamp}`;

  // The accepted commits are already on HEAD; branching here captures them.
  git.createBranch(branch);
  log(`  branch ${branch} (${result.acceptedCommits.length} commit(s))`);

  const fix: ShippedFix = {
    issueId: result.issue.id,
    url: result.issue.url,
    kind: result.issue.kind,
    branch,
    shippedAt: new Date().toISOString(),
    clarityRateBefore: result.issue.rate,
    affectedSessionsBefore: result.issue.affectedSessions,
    probeBefore: result.baseline.total,
    probeAfter: result.final.total,
    commits: result.acceptedCommits,
  };

  if (!options.dryRun) {
    try {
      git.push(branch);
      const title = `fix(ux): ${result.issue.kind} on ${result.issue.url}`;
      fix.prUrl = git.openPullRequest(title, prBody(result), config.prBaseBranch);
      log(`  PR: ${fix.prUrl}`);
    } catch (error) {
      log(`  ! could not open PR: ${error instanceof Error ? error.message : String(error)}`);
      log(`    The branch ${branch} still holds the commits — open the PR manually.`);
    }
  } else {
    log(`  dry run — not pushing. Inspect with: git -C ${config.targetRepoPath} log ${branch}`);
  }

  // Leave the user's working branch exactly as we found it.
  git.checkout(originalBranch);
  git.revertTo(result.startCommit);
  log(`  restored ${originalBranch} to ${result.startCommit.slice(0, 8)}`);

  recordShipped(fix);
  return fix;
}
