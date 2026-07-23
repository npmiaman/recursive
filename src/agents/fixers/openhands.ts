import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../../config.ts";
import { buildFixPrompt } from "./prompt.ts";
import type { FixAttempt, Fixer, FixRequest } from "./types.ts";

/**
 * OpenHands engine, the self-hostable, zero-egress option.
 *
 * COMMERCIAL POSITION: MIT licensed. You may embed it in a commercial product,
 * modify it, and redistribute it, provided the copyright notice and licence text
 * travel with it. No copyleft obligation on Recursive's own source.
 *
 * WHY IT EXISTS HERE: it is model-agnostic. A customer who cannot let source code
 * or prompts cross their network boundary, the common blocker in BFSI, regulated
 * public-sector work, and some GCC engagements, points `baseUrl` at a model they
 * host and runs the entire fix stage inside their own perimeter. Recursive never
 * sees their code and neither does anyone else.
 *
 * The trade is quality: an open model behind a self-hosted endpoint will not match
 * the Claude engine. That is the customer's call to make, which is exactly why
 * this is per-project configuration rather than a global decision.
 */

export interface OpenHandsConfig {
  /** Model identifier passed to the OpenHands LLM constructor. */
  model: string;
  /** OpenAI-compatible base URL. Set this to keep everything on-premises. */
  baseUrl?: string;
  /** Name of the env var holding the model API key. */
  apiKeyEnv?: string;
  /** Python interpreter to use. */
  python?: string;
}

interface BridgeResponse {
  summary: string;
  turns: number;
  ok: boolean;
  error: string | null;
}

export class OpenHandsFixer implements Fixer {
  readonly name = "openhands";
  readonly licence = "MIT, embed, modify and redistribute freely (keep the notice)";
  readonly selfContained = true;

  private readonly settings: Required<Pick<OpenHandsConfig, "model" | "python">> & OpenHandsConfig;

  constructor(settings: OpenHandsConfig) {
    this.settings = {
      python: "python3",
      apiKeyEnv: "LLM_API_KEY",
      ...settings,
    };
  }

  private bridgePath(): string {
    return resolve(ROOT, "bridge", "openhands_fix.py");
  }

  async preflight(): Promise<void> {
    const bridge = this.bridgePath();
    if (!existsSync(bridge)) {
      throw new Error(`OpenHands bridge script is missing at ${bridge}.`);
    }

    await new Promise<void>((res, rej) => {
      execFile(this.settings.python, ["-c", "import openhands.sdk"], (error) => {
        if (error) {
          rej(
            new Error(
              `The OpenHands SDK is not importable by '${this.settings.python}'. ` +
                `Install it with:\n    ${this.settings.python} -m pip install openhands\n` +
                `Or switch this project's fixEngine back to 'claude-agent-sdk'.`,
            ),
          );
          return;
        }
        res();
      });
    });

    if (!this.settings.baseUrl && !process.env[this.settings.apiKeyEnv!]) {
      throw new Error(
        `OpenHands needs either a model API key in $${this.settings.apiKeyEnv} or a ` +
          `baseUrl pointing at a self-hosted model.`,
      );
    }
  }

  async apply(request: FixRequest): Promise<FixAttempt> {
    const payload = JSON.stringify({
      prompt: buildFixPrompt(request),
      repoPath: request.repoPath,
      model: this.settings.model,
      baseUrl: this.settings.baseUrl ?? null,
      apiKeyEnv: this.settings.apiKeyEnv,
    });

    const response = await new Promise<BridgeResponse>((res, rej) => {
      const child = execFile(
        this.settings.python,
        [this.bridgePath()],
        // The agent transcript can be large; don't truncate it into invalid JSON.
        { maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 },
        (error, stdout, stderr) => {
          if (error && !stdout) {
            rej(new Error(`OpenHands bridge failed: ${stderr || error.message}`));
            return;
          }
          try {
            res(JSON.parse(stdout) as BridgeResponse);
          } catch {
            rej(new Error(`OpenHands bridge returned unparseable output: ${stdout.slice(0, 500)}`));
          }
        },
      );
      child.stdin?.write(payload);
      child.stdin?.end();
    });

    if (!response.ok) {
      throw new Error(response.error ?? "OpenHands run failed for an unreported reason.");
    }

    return {
      summary: response.summary,
      // Advisory only. The loop checks git for ground truth either way, which is
      // what makes it safe to run an engine whose transcript we can't fully read.
      edited: response.summary.length > 0,
      turns: response.turns,
      engine: this.name,
    };
  }
}
