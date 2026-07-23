import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { KIND_MEANING, type Issue } from "../diagnose/issues.ts";
import { programSection } from "../program.ts";
import type { FixDirection, Investigation } from "./investigate.ts";

/**
 * The code-editing stage — the only place the system writes to your repo.
 *
 * This uses the Claude Agent SDK rather than the plain Messages API because it
 * needs the built-in filesystem and shell tools to locate the responsible
 * component and edit it. The inner loop wraps every call to this in a git
 * checkpoint, so a bad edit is always recoverable.
 */

export interface FixAttempt {
  /** What the agent says it changed. */
  summary: string;
  /** Whether the agent reported making any edit at all. */
  edited: boolean;
  turns: number;
}

/**
 * Pull readable text out of the Agent SDK's message stream.
 * Written defensively across message shapes so an SDK revision that adds or
 * renames a block type degrades to "less text" rather than a crash mid-loop.
 */
function extractText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const m = message as Record<string, unknown>;

  if (m["type"] === "text" && typeof m["text"] === "string") return m["text"];

  if (m["type"] === "result") {
    if (typeof m["result"] === "string") return m["result"];
  }

  // assistant messages nest an Anthropic Message under `message`
  const nested = m["message"];
  if (typeof nested === "object" && nested !== null) {
    const content = (nested as Record<string, unknown>)["content"];
    if (Array.isArray(content)) {
      return content
        .filter(
          (b): b is { type: "text"; text: string } =>
            typeof b === "object" &&
            b !== null &&
            (b as Record<string, unknown>)["type"] === "text" &&
            typeof (b as Record<string, unknown>)["text"] === "string",
        )
        .map((b) => b.text)
        .join("\n");
    }
  }
  return "";
}

const SYSTEM_APPEND = `
You are fixing a specific, measured UX defect in this repository.

Hard constraints:
- Make the SMALLEST change that addresses the stated cause. No refactors, no new
  abstractions, no reformatting of untouched code, no "while I'm here" cleanups.
- Do not modify tests to make anything pass. Do not touch CI config.
- Do not install dependencies or change lockfiles unless the fix is impossible
  without it — and if so, say why in your summary.
- Match the surrounding code's conventions exactly: same component patterns,
  same styling approach, same naming.
- If you cannot locate the responsible code with reasonable confidence, STOP and
  say so plainly. A truthful "not found" is far more useful here than a plausible
  edit to the wrong file — an automated loop will measure and ship whatever you do.

Finish with a one-paragraph summary naming each file you changed and what changed
in it.`;

export async function applyFix(
  issue: Issue,
  direction: FixDirection,
  investigation: Investigation,
  researchNotes: string | undefined,
  attemptNumber: number,
  previousAttempts: { direction: string; scoreDelta: number }[],
): Promise<FixAttempt> {
  if (!config.targetRepoPath) {
    throw new Error("TARGET_REPO_PATH is not set — nowhere to apply the fix.");
  }

  const history = previousAttempts.length
    ? `\n## Previous attempts on this issue (all reverted)\n\n${previousAttempts
        .map(
          (a, i) =>
            `${i + 1}. "${a.direction}" → score moved ${a.scoreDelta >= 0 ? "+" : ""}${a.scoreDelta.toFixed(4)} (${a.scoreDelta >= 0 ? "worse or no better" : "better"})`,
        )
        .join("\n")}\n\nDo not repeat an approach that already failed. Try something materially different.\n`
    : "";

  const prompt = `# Fix a measured UX defect
${programSection()}
## The defect

Microsoft Clarity observed **${issue.kind}** on \`${issue.url}\`, affecting
${issue.affectedSessions.toLocaleString()} of ${issue.totalSessions.toLocaleString()} sessions (${(issue.rate * 100).toFixed(1)}%).

${KIND_MEANING[issue.kind]}

## Root cause (from analysis of headless-browser probe evidence)

${investigation.hypothesis}

${investigation.suspectSelectors.length ? `Suspect selectors:\n${investigation.suspectSelectors.map((s) => `- \`${s}\``).join("\n")}\n` : ""}
${investigation.searchTerms.length ? `Try grepping this repo for: ${investigation.searchTerms.map((t) => `\`${t}\``).join(", ")}\n` : ""}
${researchNotes ? `## External research findings\n\n${researchNotes}\n` : ""}${history}
## The fix to implement (attempt ${attemptNumber})

**${direction.title}** (risk: ${direction.risk})

${direction.rationale}

Approach: ${direction.approach}

## Task

Locate the responsible code and implement exactly this fix. Then summarise what you changed.`;

  let text = "";
  let turns = 0;

  for await (const message of query({
    prompt,
    options: {
      model: config.model,
      cwd: config.targetRepoPath,
      maxTurns: 30,
      systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
      allowedTools: ["Read", "Edit", "Write", "Grep", "Glob", "Bash"],
      // The loop owns safety here: every attempt runs inside a git checkpoint
      // that is hard-reset when the score does not improve.
      permissionMode: "bypassPermissions",
    },
  })) {
    turns++;
    const chunk = extractText(message);
    if (chunk) text += chunk + "\n";
  }

  const summary = text.trim();
  return {
    summary,
    edited: summary.length > 0 && !/^\s*(i (could not|couldn't|was unable)|no changes)/i.test(summary),
    turns,
  };
}
