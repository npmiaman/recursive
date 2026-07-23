import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Git as the change oracle.
 *
 * This replaces the weakest assumption in the earlier design. Previously
 * Recursive needed the customer to call `recordRelease()` from their CI, an
 * integration you have to ask for, that quietly breaks, and without which
 * nothing gets contained.
 *
 * The repository already knows all of it, and knows more: not just *that*
 * something shipped, but exactly which files changed, who touched them, and
 * which parts of the codebase are churning. That turns "an update caused this"
 * from a bare correlation into a ranked list of suspect files.
 */

export interface GitCommit {
  sha: string;
  shortSha: string;
  at: string;
  author: string;
  subject: string;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  status: "A" | "M" | "D" | "R" | string;
}

export class NotAGitRepo extends Error {
  constructor(path: string) {
    super(
      `${path} is not a git repository (or git is unavailable). ` +
        `Recursive derives release history from git, so the fix loop needs a real checkout.`,
    );
    this.name = "NotAGitRepo";
  }
}

export class Repo {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
    if (!existsSync(this.path)) throw new NotAGitRepo(this.path);
  }

  private git(args: string[]): string {
    try {
      return execFileSync("git", args, {
        cwd: this.path,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not a git repository/i.test(message)) throw new NotAGitRepo(this.path);
      throw error;
    }
  }

  isRepo(): boolean {
    try {
      return this.git(["rev-parse", "--is-inside-work-tree"]) === "true";
    } catch {
      return false;
    }
  }

  head(): string {
    return this.git(["rev-parse", "HEAD"]);
  }

  currentBranch(): string {
    return this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  // ---- write operations, used by the repair loop ------------------------
  //
  // The keep-or-revert model only holds if reverting is exact, so these are
  // deliberately blunt: a hard reset plus a clean, not a best-effort undo.
  // `src/git.ts` has the same operations bound to config.targetRepoPath; these
  // take the repo explicitly because the repair loop is handed a path.

  /**
   * Paths differing from HEAD, including untracked ones.
   *
   * This is the ground truth for "did the agent actually change anything". An
   * engine reporting success while editing nothing is a failure mode we have
   * already seen, so its own claim is never trusted.
   */
  dirtyFiles(): string[] {
    return (
      this.git(["status", "--porcelain"])
        .split("\n")
        .filter(Boolean)
        // Porcelain v1: two status chars, a space, then the path. Renames appear
        // as "old -> new"; the new path is the one that exists.
        .map((line) => {
          const path = line.slice(3).trim();
          const renamed = path.split(" -> ");
          return (renamed[1] ?? renamed[0] ?? "").replace(/^"|"$/g, "");
        })
        .filter(Boolean)
    );
  }

  /** Commit everything in the working tree. Returns the new SHA. */
  commitAll(message: string): string {
    this.git(["add", "-A"]);
    // --no-verify because a repo's pre-commit hooks may run the very test suite
    // being repaired, which would deadlock the loop on a failing checkpoint.
    this.git(["commit", "-m", message, "--no-verify"]);
    return this.head();
  }

  /** Discard everything after `sha`, including files the agent created. */
  resetHard(sha: string): void {
    this.git(["reset", "--hard", sha]);
    this.git(["clean", "-fd"]);
  }

  /** Commits in reverse-chronological order, newest first. */
  log(options: { since?: string; limit?: number; branch?: string } = {}): GitCommit[] {
    const args = ["log", "--date=iso-strict", "--pretty=format:%H%x1f%aI%x1f%an%x1f%s"];
    if (options.since) args.push(`--since=${options.since}`);
    if (options.limit) args.push(`-n${options.limit}`);
    if (options.branch) args.push(options.branch);

    const out = this.git(args);
    if (!out) return [];

    return out.split("\n").map((line) => {
      const [sha = "", at = "", author = "", subject = ""] = line.split("\x1f");
      return { sha, shortSha: sha.slice(0, 8), at, author, subject };
    });
  }

  /**
   * The commit most likely to have introduced a failure first seen at `time`.
   *
   * The newest commit landing before the failure appeared. Deliberately simple:
   * a deploy usually carries several commits, and narrowing further is what the
   * per-file suspicion ranking is for, guessing harder here would only add
   * false precision.
   */
  suspectCommit(time: Date, windowHours = 24): GitCommit | undefined {
    const since = new Date(time.getTime() - windowHours * 3600_000).toISOString();
    const candidates = this.log({ since }).filter((c) => Date.parse(c.at) <= time.getTime());
    return candidates[0];
  }

  /** Files changed by a commit, with churn size. */
  changedFiles(sha: string): FileChange[] {
    const out = this.git(["show", "--numstat", "--format=", sha]);
    if (!out) return [];

    const statuses = new Map<string, string>();
    const nameStatus = this.git(["show", "--name-status", "--format=", sha]);
    for (const line of nameStatus.split("\n")) {
      const [status = "", path = ""] = line.split("\t");
      if (path) statuses.set(path, status.charAt(0));
    }

    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added = "0", removed = "0", path = ""] = line.split("\t");
        return {
          path,
          // Binary files report "-" rather than a count.
          added: added === "-" ? 0 : Number(added) || 0,
          removed: removed === "-" ? 0 : Number(removed) || 0,
          status: statuses.get(path) ?? "M",
        };
      })
      .filter((change) => change.path && change.status !== "D");
  }

  /** Files changed between two refs, the diff a whole release carried. */
  changedBetween(from: string, to = "HEAD"): FileChange[] {
    const out = this.git(["diff", "--numstat", `${from}..${to}`]);
    if (!out) return [];
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added = "0", removed = "0", path = ""] = line.split("\t");
        return {
          path,
          added: added === "-" ? 0 : Number(added) || 0,
          removed: removed === "-" ? 0 : Number(removed) || 0,
          status: "M",
        };
      })
      .filter((c) => c.path);
  }

  /**
   * Change frequency per file over a window.
   *
   * Churn is one of the strongest empirical predictors of defects, code that
   * changes often breaks often. Used to break ties during ranking, never on its
   * own, because a file that legitimately changes every day would otherwise be
   * permanently blamed for everything.
   */
  churn(sinceDays = 30): Map<string, number> {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const out = this.git(["log", `--since=${since}`, "--name-only", "--pretty=format:"]);
    const counts = new Map<string, number>();
    for (const line of out.split("\n")) {
      const path = line.trim();
      if (!path) continue;
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    return counts;
  }

  /** Who last touched each line of a file, points at the change that broke it. */
  blame(path: string, startLine?: number, endLine?: number): GitCommit[] {
    const args = ["blame", "--line-porcelain"];
    if (startLine !== undefined) {
      args.push("-L", `${startLine},${endLine ?? startLine}`);
    }
    args.push("--", path);

    let out: string;
    try {
      out = this.git(args);
    } catch {
      return [];
    }

    const commits: GitCommit[] = [];
    const seen = new Set<string>();
    let sha = "";
    let author = "";
    let at = "";
    let subject = "";

    for (const line of out.split("\n")) {
      if (/^[0-9a-f]{40} /.test(line)) sha = line.slice(0, 40);
      else if (line.startsWith("author ")) author = line.slice(7);
      else if (line.startsWith("author-time ")) {
        at = new Date(Number(line.slice(12)) * 1000).toISOString();
      } else if (line.startsWith("summary ")) {
        subject = line.slice(8);
        if (sha && !seen.has(sha)) {
          seen.add(sha);
          commits.push({ sha, shortSha: sha.slice(0, 8), at, author, subject });
        }
      }
    }
    return commits;
  }

  /**
   * Source files in the working tree, respecting .gitignore for free.
   *
   * `--others --exclude-standard` is load-bearing, not a nicety. Plain
   * `ls-files` returns only *tracked* files, which meant a brand-new file was
   * invisible to retrieval until someone committed it, and invisible
   * *silently*, producing a confidently wrong answer rather than an error. On
   * this repo it hid 45 of 88 source files, including entire directories, and
   * the retrieval benchmark scored those files as "not found" when the truth
   * was "not indexed".
   *
   * That is precisely backwards for a tool that investigates fresh breakage:
   * the code most likely to be at fault is the code someone just wrote.
   * `--exclude-standard` keeps .gitignore honoured, so build output and
   * node_modules still stay out.
   */
  listFiles(patterns: string[] = []): string[] {
    const args = ["ls-files", "--cached", "--others", "--exclude-standard"];
    if (patterns.length) args.push("--", ...patterns);
    const out = this.git(args);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  /** File contents at a ref, without touching the working tree. */
  showFile(path: string, ref = "HEAD"): string | undefined {
    try {
      return this.git(["show", `${ref}:${path}`]);
    } catch {
      return undefined;
    }
  }
}

/**
 * A "release" derived from git rather than declared by CI.
 *
 * Prefers annotated tags when a team uses them, and falls back to treating
 * commits on the main branch as the release stream. Either way there is no
 * integration for the customer to build, and nothing to forget to call.
 */
export interface DerivedRelease {
  id: string;
  sha: string;
  at: string;
  subject: string;
  /** True if this came from a real tag rather than a bare commit. */
  tagged: boolean;
}

export function derivedReleases(repo: Repo, limit = 50): DerivedRelease[] {
  const tags = (() => {
    try {
      const out = execFileSync(
        "git",
        [
          "for-each-ref",
          "--sort=-creatordate",
          "--format=%(refname:short)%09%(objectname)%09%(creatordate:iso-strict)%09%(contents:subject)",
          "refs/tags",
          `--count=${limit}`,
        ],
        { cwd: repo.path, encoding: "utf8" },
      ).trim();
      return out ? out.split("\n") : [];
    } catch {
      return [];
    }
  })();

  if (tags.length > 0) {
    return tags.map((line) => {
      const [id = "", sha = "", at = "", subject = ""] = line.split("\t");
      return { id, sha, at, subject, tagged: true };
    });
  }

  // No tags, treat commits as the release stream. Less precise, but it means
  // Recursive works on day one in a repo that has never tagged anything.
  return repo.log({ limit }).map((commit) => ({
    id: commit.shortSha,
    sha: commit.sha,
    at: commit.at,
    subject: commit.subject,
    tagged: false,
  }));
}
