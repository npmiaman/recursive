import { runCodingAgent } from "../coding/agent.ts";
import { buildFixPrompt } from "./prompt.ts";
import type { FixAttempt, Fixer, FixRequest } from "./types.ts";

/**
 * Agentic code-editing engine, the same shape as Claude Code.
 *
 * Unlike the single-shot `native` engine, this one runs a real tool-using loop:
 * it lists, searches, reads, edits, and runs commands to check its own work,
 * carrying the whole trail in its context between turns. It needs an
 * OpenAI-compatible endpoint (NVIDIA, Ollama, vLLM, OpenAI), so it writes code
 * against a free NVIDIA model with no extra dependency.
 *
 * Its brief is deliberately LESS restrictive than the other engines'. Recursive
 * ends at a pull request a human reviews and merges, so the agent is told to fix
 * the problem *properly*, refactor and touch multiple files if that is the right
 * call, rather than being forced into the smallest possible diff. The only hard
 * rails are the ones that would corrupt the signal: do not delete or disable the
 * feature to make a check pass, and do not edit tests or CI to fake success.
 */

const AGENTIC_SYSTEM = `You are a senior engineer fixing a real defect in this repository, working through tools.

You have these tools: list_files, search, read_file, edit_file, write_file, run_command, finish.

How to work:
- Start by orienting: search and read to find the code actually responsible. Do not guess.
- Fix the problem properly. You MAY refactor, add helper functions, introduce a small
  abstraction, or change several files if that is genuinely the right fix. A human reviews
  your change as a pull request before it ships, so favour a correct, clean fix over a
  minimal one. Do not, however, make sweeping unrelated changes.
- Match the surrounding code's conventions, naming, and style.
- CHECK YOUR OWN WORK before finishing: run the build or the relevant tests with run_command
  and read the output. If it fails, keep going.
- When, and only when, the fix is complete and verified, call finish with a summary.

Hard rails, never cross these:
- Do NOT delete, hide, comment out, or feature-flag the feature off to make a check pass.
  The feature must keep working; repair it.
- Do NOT edit tests, fixtures, or CI configuration to force a pass.
- Do NOT exfiltrate secrets or run destructive commands (no rm -rf, no network installs
  unless the fix genuinely requires a dependency, and say so if it does).

If after honest effort you cannot locate or fix the problem, call finish and say so plainly.
A truthful "not fixed" is more useful than a plausible edit to the wrong place.`;

export class AgenticFixer implements Fixer {
  readonly name = "agentic";
  readonly licence =
    "Uses the configured LLM_PROVIDER. Self-contained only if that provider is self-hosted.";
  readonly selfContained = false;

  /** Optional sink for tool-call narration, wired by the caller that wants it. */
  private readonly onEvent?: (line: string) => void;

  constructor(onEvent?: (line: string) => void) {
    this.onEvent = onEvent;
  }

  async preflight(): Promise<void> {
    const { resolveProvider } = await import("../../llm/provider.ts");
    await resolveProvider().preflight();
  }

  async apply(request: FixRequest): Promise<FixAttempt> {
    const result = await runCodingAgent({
      repoPath: request.repoPath,
      system: AGENTIC_SYSTEM,
      // Reuse the shared fix prompt for the task body: it already assembles the
      // defect, the hypothesis, the retrieved code, memory of past attempts, and
      // the direction to try. The agent then explores from there with its tools.
      task: buildFixPrompt(request),
      maxTurns: 40,
      onEvent: this.onEvent,
    });

    return {
      summary: result.summary,
      // git is still the ground truth downstream; this is the agent's own claim.
      edited: result.filesChanged.length > 0,
      turns: result.turns,
      engine: this.name,
    };
  }
}
