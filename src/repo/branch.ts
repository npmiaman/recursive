import { execFileSync } from "node:child_process";
import type { Area } from "./areas.ts";

/**
 * Branch strategy.
 *
 * Recursive works the way a team does: one long-lived branch per area of the
 * system, reused across fixes, rather than a fresh branch per bug.
 *
 * recursive/frontend recursive/backend recursive/ml recursive/infra
 *
 * Why this matters more than it looks:
 *  - A PR per bug buries reviewers. A PR per area gives them one coherent thing
 * to read, and it stays open and accumulates.
 *  - Different areas have different reviewers. Frontend fixes shouldn't land in
 * front of the ML team.
 *  - Related fixes in the same area often touch the same files. On separate
 * branches they'd conflict with each other; on one branch they compose.
 *
 * The branch is always brought up to date with the base before new work lands,
 * so a fix is never written against stale code.
 */

const PREFIX = "recursive";

export interface BranchOptions {
  repoPath: string;
  /** Branch to base off and target PRs at. */
  base: string;
}

function git(repoPath: string, args: string[], allowFail = false): string {
  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", allowFail ? "ignore" : "pipe"],
    }).trim();
  } catch (error) {
    if (allowFail) return "";
    throw error;
  }
}

export function branchNameFor(area: Area): string {
  return `${PREFIX}/${area}`;
}

export function branchExistsLocally(repoPath: string, branch: string): boolean {
  return git(repoPath, ["rev-parse", "--verify", "--quiet", branch], true) !== "";
}

export function branchExistsRemotely(repoPath: string, branch: string): boolean {
  return git(repoPath, ["ls-remote", "--heads", "origin", branch], true) !== "";
}

export function hasRemote(repoPath: string): boolean {
  return git(repoPath, ["remote"], true)
    .split("\n")
    .some((r) => r.trim() === "origin");
}

export interface AreaBranchResult {
  branch: string;
  /** True if this run created it; false if it already existed and was reused. */
  created: boolean;
  /** True if base commits were merged in to bring it current. */
  updatedFromBase: boolean;
  /** Commits already on this branch that aren't on base, prior Recursive fixes. */
  existingCommits: number;
}

/**
 * Check out the area branch, creating it from base if needed, and bring it up to
 * date with base.
 *
 * Merge rather than rebase, deliberately: the branch may already be pushed and
 * under review, and rebasing would force-push history out from under a reviewer
 * mid-read. A merge commit is uglier and correct.
 */
export function checkoutAreaBranch(area: Area, options: BranchOptions): AreaBranchResult {
  const { repoPath, base } = options;
  const branch = branchNameFor(area);

  let created = false;
  let updatedFromBase = false;

  const localExists = branchExistsLocally(repoPath, branch);
  const remoteExists = hasRemote(repoPath) && branchExistsRemotely(repoPath, branch);

  if (localExists) {
    git(repoPath, ["checkout", branch]);
  } else if (remoteExists) {
    // Someone else's Recursive run, or a previous run on another machine.
    git(repoPath, ["fetch", "origin", branch]);
    git(repoPath, ["checkout", "-b", branch, `origin/${branch}`]);
  } else {
    git(repoPath, ["checkout", "-b", branch, base]);
    created = true;
  }

  if (!created) {
    // Bring in anything that landed on base since this branch last moved, so
    // fixes are written against current code rather than a stale snapshot.
    const behind = git(repoPath, ["rev-list", "--count", `${branch}..${base}`], true);
    if (behind && Number(behind) > 0) {
      try {
        git(repoPath, ["merge", "--no-edit", base]);
        updatedFromBase = true;
      } catch {
        // A conflict means the area branch has drifted far enough that a human
        // needs to reconcile it. Better to stop than to guess at a resolution.
        git(repoPath, ["merge", "--abort"], true);
        throw new Error(
          `Branch '${branch}' conflicts with '${base}' and cannot be updated automatically. ` +
            `Resolve it manually. Recursive will not guess at a merge resolution.`,
        );
      }
    }
  }

  const existingCommits = Number(
    git(repoPath, ["rev-list", "--count", `${base}..${branch}`], true) || "0",
  );

  return { branch, created, updatedFromBase, existingCommits };
}

/**
 * Move a set of commits onto the currently checked-out branch.
 * Used to transplant accepted hill-climb commits onto the area branch, since the
 * area isn't known until we can see which files the fix touched.
 */
export function cherryPick(repoPath: string, commits: string[]): void {
  for (const commit of commits) {
    try {
      git(repoPath, ["cherry-pick", commit]);
    } catch {
      git(repoPath, ["cherry-pick", "--abort"], true);
      throw new Error(
        `Could not apply commit ${commit.slice(0, 8)} to the area branch, it conflicts with ` +
          `work already there. The fix is still on the original branch; apply it manually.`,
      );
    }
  }
}

export function push(repoPath: string, branch: string): void {
  git(repoPath, ["push", "-u", "origin", branch]);
}

export interface PullRequest {
  number: number;
  url: string;
  /** True if this call created it; false if an open one was updated by the push. */
  created: boolean;
}

/**
 * Open a PR for the area branch, or find the one already open.
 *
 * Pushing to a branch with an open PR updates that PR automatically, so the
 * common case after the first fix is "found existing, nothing to do", which is
 * exactly the accumulate-into-one-review behaviour we want.
 */
export function upsertPullRequest(
  repoPath: string,
  branch: string,
  base: string,
  title: string,
  body: string,
): PullRequest {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "The `gh` CLI is required to open PRs. Install it (https://cli.github.com) and run `gh auth login`.",
    );
  }

  // Is there already an open PR for this branch?
  let listed = "";
  try {
    listed = execFileSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"],
      { cwd: repoPath, encoding: "utf8" },
    ).trim();
  } catch {
    listed = "";
  }

  if (listed && listed !== "[]") {
    try {
      const parsed = JSON.parse(listed) as { number: number; url: string }[];
      if (parsed[0]) {
        return { number: parsed[0].number, url: parsed[0].url, created: false };
      }
    } catch {
      /* fall through to create */
    }
  }

  const url = execFileSync(
    "gh",
    ["pr", "create", "--title", title, "--body", body, "--base", base, "--head", branch],
    { cwd: repoPath, encoding: "utf8" },
  ).trim();

  const match = url.match(/\/pull\/(\d+)/);
  return { number: match ? Number(match[1]) : 0, url, created: true };
}

/**
 * Merge a PR, for autonomous ("auto-PR") mode.
 *
 * This is the one action Recursive will not take unless a human explicitly turns
 * it on, because it is the step that puts an unreviewed change into the base
 * branch. When enabled, the safety that remains is upstream, not here: the
 * repair only reaches this point after the closed loop verified it against the
 * real user journey, and branch protection or required checks on the repo (if
 * configured) still gate the merge. `--squash` keeps the base-branch history one
 * commit per fix rather than a chain of cycle commits.
 *
 * Returns true if the merge went through. A blocked merge (protected branch,
 * failing required check) is reported, not thrown, so autonomous runs downgrade
 * to "PR opened, awaiting a human" rather than crashing.
 */
export function mergePullRequest(
  repoPath: string,
  prNumber: number,
  method: "squash" | "merge" | "rebase" = "squash",
): { merged: boolean; note: string } {
  try {
    execFileSync("gh", ["pr", "merge", String(prNumber), `--${method}`, "--delete-branch"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { merged: true, note: `merged PR #${prNumber} (${method})` };
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    return {
      merged: false,
      note: `could not merge PR #${prNumber}: ${(e.stderr || e.message || "unknown").trim().split("\n")[0]}`,
    };
  }
}

/** Append a comment to an existing PR, how additional fixes announce themselves. */
export function commentOnPullRequest(repoPath: string, prNumber: number, body: string): void {
  try {
    execFileSync("gh", ["pr", "comment", String(prNumber), "--body", body], {
      cwd: repoPath,
      stdio: "ignore",
    });
  } catch {
    // A missing comment is cosmetic; never fail a shipped fix over it.
  }
}
