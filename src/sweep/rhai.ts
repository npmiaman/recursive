import { spawn } from "node:child_process";
import type { Flow } from "./flows.ts";

/**
 * Adapter for rhai (https://github.com/npmiaman/rhai), a browsing agent that
 * drives a real Chrome session with a plan/act/verify loop.
 *
 * Why a browsing agent rather than Playwright specs: selector-based tests break
 * on every redesign, so teams stop trusting them and eventually delete them. A
 * goal like "buy something" survives the button moving. The trade is
 * non-determinism, which is why a failure here produces a *signal* to be
 * corroborated rather than an immediate verdict, see confirmFailure().
 *
 * Three details taken from rhai's source rather than assumed, each of which
 * silently breaks the integration if you get it wrong:
 *   1. All output goes to STDERR (console.error), not stdout.
 *   2. RHAI_NO_UI=1 is required, or the TUI writes escape codes into the capture.
 *   3. Long context goes via RHAI_TASK_CONTEXT to dodge shell quoting entirely.
 */

export interface RhaiResult {
  flowId: string;
  status: "passed" | "failed" | "error";
  /** rhai's own one-line summary. */
  summary: string;
  /** Full captured transcript, the evidence attached to any resulting signal. */
  transcript: string;
  durationMs: number;
  /** Non-zero exit or a thrown error, as opposed to a clean "flow is broken". */
  infrastructureError?: string;
}

export interface RhaiOptions {
  baseUrl: string;
  /**
   * How to invoke rhai. Defaults to `npx -y rhai-mcp`.
   * Override via RHAI_COMMAND for a global install, a pinned version, or a
   * stub in tests, spawning npx on every flow is slow and needs a network.
   */
  command?: string;
  /** Watch it work, useful when a sweep keeps failing and you don't believe it. */
  headless?: boolean;
  model?: string;
  maxSteps?: number;
  timeoutMs?: number;
}

/**
 * Model per tier. Overridable so a team can tune cost without code changes.
 *
 * The point of tiering is that most flows are short and well-trodden, running
 * the strongest model on "can you log in" is pure waste. A `fast` flow that
 * fails is re-run at `standard` before being believed, so the cheap model can
 * cost latency but never correctness.
 */
export const TIER_MODELS: Record<"fast" | "standard" | "careful", string | undefined> = {
  fast: process.env["RHAI_MODEL_FAST"] ?? "gpt-5-mini",
  standard: process.env["RHAI_MODEL"] ?? undefined, // rhai's own default
  careful: process.env["RHAI_MODEL_CAREFUL"] ?? "gpt-5",
};

/** Default step caps per tier, a confused agent should stop, not wander. */
export const TIER_MAX_STEPS: Record<"fast" | "standard" | "careful", number> = {
  fast: 15,
  standard: 30,
  careful: 50,
};

/** rhai colours its output; escape codes would pollute stored transcripts. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Build the goal handed to rhai.
 *
 * Explicitly instructs it to REPORT rather than repair. rhai self-corrects when
 * it hits a roadblock, which is exactly wrong here, if it works around a broken
 * button, the bug goes unreported and the sweep is worse than useless.
 */
function buildGoal(flow: Flow): string {
  return [
    `Act as a real user and complete this task: ${flow.goal}`,
    "",
    `Success means: ${flow.expect}`,
    "",
    "IMPORTANT, you are TESTING, not fixing:",
    "- If something does not work, STOP and report exactly what you did, what you expected, and what happened instead.",
    "- Do NOT work around a broken control by finding another route. A workaround hides the bug.",
    "- Report the specific element that failed and any visible error text.",
    "- If everything works, say PASS and describe the final state you observed.",
  ].join("\n");
}

export async function runFlow(flow: Flow, options: RhaiOptions): Promise<RhaiResult> {
  const started = Date.now();
  const url = new URL(flow.url, options.baseUrl).toString();

  return new Promise<RhaiResult>((resolve) => {
    const [command, ...baseArgs] = (
      options.command ??
      process.env["RHAI_COMMAND"] ??
      "npx -y rhai-mcp"
    ).split(/\s+/);

    const child = spawn(command!, [...baseArgs, "task", buildGoal(flow), url], {
      env: {
        ...process.env,
        RHAI_NO_UI: "1", // required: otherwise the TUI corrupts the capture
        RHAI_HEADLESS: options.headless === false ? "false" : "true",
        ...(options.model ? { RHAI_MODEL: options.model } : {}),
        ...(options.maxSteps ? { RHAI_MAX_STEPS: String(options.maxSteps) } : {}),
        ...(flow.context ? { RHAI_TASK_CONTEXT: flow.context } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));

    const timeout = setTimeout(
      () => {
        child.kill("SIGKILL");
      },
      options.timeoutMs ?? 10 * 60_000,
    );

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        flowId: flow.id,
        status: "error",
        summary: `Could not launch rhai: ${error.message}`,
        transcript: stripAnsi(stderr + stdout),
        durationMs: Date.now() - started,
        infrastructureError: error.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const transcript = stripAnsi(stderr + stdout).trim();

      // rhai prints "✓ <summary>" or "✗ <summary>" as its last meaningful line.
      const lines = transcript.split("\n").filter((l) => l.trim());
      const marker = [...lines].reverse().find((l) => l.includes("✓") || l.includes("✗"));
      const summary = (marker ?? lines[lines.length - 1] ?? "no output")
        .replace(/^[✓✗]\s*/, "")
        .trim();

      // A missing OPENAI_API_KEY or a Chromium that won't launch is our problem,
      // not the product's, it must not be reported as a product failure.
      const infrastructure =
        /OPENAI_API_KEY is not set|Could not launch|ENOENT|command not found|browserType\.launch/i.test(
          transcript,
        );

      if (infrastructure) {
        resolve({
          flowId: flow.id,
          status: "error",
          summary: "rhai could not run (environment problem, not a product failure)",
          transcript,
          durationMs: Date.now() - started,
          infrastructureError: summary,
        });
        return;
      }

      resolve({
        flowId: flow.id,
        status: code === 0 && !/\bFAIL\b/i.test(summary) ? "passed" : "failed",
        summary,
        transcript,
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * Re-run a failed flow to see whether the failure is real.
 *
 * A browsing agent is non-deterministic: it can misread a page, click the wrong
 * thing, or hit a slow render. Opening a PR against a flake would burn the
 * team's trust faster than any missed bug, so a failure has to reproduce before
 * it becomes a signal.
 */
export async function confirmFailure(
  flow: Flow,
  options: RhaiOptions,
  attempts = 2,
): Promise<{ confirmed: boolean; results: RhaiResult[] }> {
  const results: RhaiResult[] = [];

  for (let i = 0; i < attempts; i++) {
    const result = await runFlow(flow, options);
    results.push(result);
    // One clean pass is enough to call it a flake, a real break doesn't
    // intermittently succeed.
    if (result.status === "passed") return { confirmed: false, results };
    if (result.status === "error") return { confirmed: false, results };
  }

  return { confirmed: true, results };
}

/** Is rhai installed and configured? Checked before a sweep, not during. */
export async function preflight(): Promise<{ ok: boolean; reason?: string }> {
  if (!process.env["OPENAI_API_KEY"]) {
    return {
      ok: false,
      reason:
        "OPENAI_API_KEY is not set, rhai requires it. Put it in .env, never in a chat message.",
    };
  }

  const [command, ...baseArgs] = (process.env["RHAI_COMMAND"] ?? "npx -y rhai-mcp").split(/\s+/);

  return new Promise((resolve) => {
    const child = spawn(command!, [...baseArgs, "help"], { stdio: "ignore" });
    const timeout = setTimeout(() => {
      child.kill();
      resolve({
        ok: false,
        reason: "rhai did not respond within 60s (first run downloads Chromium).",
      });
    }, 60_000);

    child.on("error", () => {
      clearTimeout(timeout);
      resolve({ ok: false, reason: "Could not run `npx rhai-mcp`. Is Node ≥18 available?" });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0 ? { ok: true } : { ok: false, reason: `rhai exited ${code}` });
    });
  });
}
