import { execFileSync } from "node:child_process";
import { config } from "./config.ts";

/**
 * Git operations backing the hill-climb's keep/revert decision.
 *
 * AutoResearch's whole safety model is "commit if it improved, roll back if it
 * didn't". That only works if rollback is exact, so every attempt runs against a
 * recorded HEAD and a clean tree, and reverting is a hard reset plus a clean —
 * not a best-effort undo.
 */

function git(args: string[], cwd = repoPath()): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

function repoPath(): string {
  if (!config.targetRepoPath) {
    throw new Error("TARGET_REPO_PATH is not set.");
  }
  return config.targetRepoPath;
}

export function assertCleanRepo(): void {
  const status = git(["status", "--porcelain"]);
  if (status) {
    throw new Error(
      `Target repo has uncommitted changes. The loop reverts by hard-reset, which would destroy them.\n` +
        `Commit or stash first:\n${status.split("\n").slice(0, 10).join("\n")}`,
    );
  }
}

export function currentBranch(): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function head(): string {
  return git(["rev-parse", "HEAD"]);
}

/** Snapshot to return to if an attempt fails to improve the score. */
export function checkpoint(): string {
  assertCleanRepo();
  return head();
}

/** Discard everything since `commit`, including untracked files the agent created. */
export function revertTo(commit: string): void {
  git(["reset", "--hard", commit]);
  git(["clean", "-fd"]);
}

/** Whether the working tree differs from HEAD — i.e. the agent actually edited something. */
export function hasChanges(): boolean {
  return git(["status", "--porcelain"]).length > 0;
}

export function diffStat(): string {
  return git(["diff", "--stat", "HEAD"]);
}

export function diff(): string {
  return git(["diff", "HEAD"]);
}

/** Commit the current working tree as an accepted improvement. */
export function commitAll(message: string): string {
  git(["add", "-A"]);
  git(["commit", "-m", message, "--no-verify"]);
  return head();
}

export function createBranch(name: string): void {
  git(["checkout", "-b", name]);
}

export function checkout(ref: string): void {
  git(["checkout", ref]);
}

export function push(branch: string): void {
  git(["push", "-u", "origin", branch]);
}

/**
 * Open a PR via the `gh` CLI. Returns the PR URL.
 * Throws with actionable guidance if `gh` is missing or unauthenticated, since
 * that's the most common first-run failure.
 */
export function openPullRequest(title: string, body: string, base: string): string {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "The `gh` CLI is required to open PRs. Install it (https://cli.github.com) and run `gh auth login`.",
    );
  }
  return execFileSync(
    "gh",
    ["pr", "create", "--title", title, "--body", body, "--base", base],
    { cwd: repoPath(), encoding: "utf8" },
  ).trim();
}
