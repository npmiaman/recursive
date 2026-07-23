import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../../config.ts";
import { buildFixPrompt, FIX_SYSTEM } from "./prompt.ts";
import type { FixAttempt, Fixer, FixRequest } from "./types.ts";

/**
 * Claude Agent SDK engine, the quality default.
 *
 * COMMERCIAL POSITION (verified against Anthropic's published terms):
 *  - Using the Agent SDK to power a product you offer to your own customers is
 * explicitly contemplated and permitted under Anthropic's Commercial Terms.
 *  - Invoking Claude Code through the Agent SDK is the approved integration
 * path. Embedding or modifying Claude Code itself is not.
 *  - The SDK requires **API key** authentication. You cannot offer claude.ai
 * login, or resell Pro/Max plan rate limits, to your customers without prior
 * approval from Anthropic.
 *
 * Practically: either Recursive supplies the API key and bills the tokens
 * through, or the customer brings their own. Both work; it is a pricing
 * decision, not a technical one.
 *
 * Self-hosting note: this is a library you deploy, so customer source code never
 * leaves their infrastructure, only prompts reach the API. That satisfies most
 * enterprise review. It does NOT satisfy a hard zero-egress requirement, which
 * is what the OpenHands engine exists for.
 */

function extractText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const m = message as Record<string, unknown>;

  if (m["type"] === "text" && typeof m["text"] === "string") return m["text"];
  if (m["type"] === "result" && typeof m["result"] === "string") return m["result"];

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

export class ClaudeAgentFixer implements Fixer {
  readonly name = "claude-agent-sdk";
  readonly licence =
    "Anthropic Commercial Terms. OK to power customer-facing products; API key auth required";
  readonly selfContained = false;

  async preflight(): Promise<void> {
    // A bare client resolves ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then
    // an `ant auth login` profile, so an unset env var is not proof of nothing.
    // We only hard-fail on the case we can be sure about.
    if (!process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) {
      const hasProfile = process.env["ANTHROPIC_PROFILE"];
      if (!hasProfile) {
        console.warn(
          "[fixer:claude] No ANTHROPIC_API_KEY set. If you have run `ant auth login` this is fine; " +
            "otherwise the fix stage will fail on first call.",
        );
      }
    }
  }

  async apply(request: FixRequest): Promise<FixAttempt> {
    let text = "";
    let turns = 0;

    for await (const message of query({
      prompt: buildFixPrompt(request),
      options: {
        model: config.model,
        cwd: request.repoPath,
        maxTurns: 30,
        systemPrompt: { type: "preset", preset: "claude_code", append: FIX_SYSTEM },
        allowedTools: ["Read", "Edit", "Write", "Grep", "Glob", "Bash"],
        // The loop owns safety: every attempt runs inside a git checkpoint that
        // is hard-reset when the probe score does not improve.
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
      edited:
        summary.length > 0 && !/^\s*(i (could not|couldn't|was unable)|no changes)/i.test(summary),
      turns,
      engine: this.name,
    };
  }
}
