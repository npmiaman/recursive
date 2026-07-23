import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config } from "../config.ts";

/**
 * Shared Claude client for the reasoning stages (diagnosis, investigation,
 * research). The code-editing stage uses the Claude Agent SDK instead — see
 * agents/fix.ts — because it needs filesystem and bash tools.
 *
 * A bare constructor is intentional: it resolves ANTHROPIC_API_KEY, then
 * ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile. Passing an explicit
 * undefined key would break the profile path.
 */
export const claude = config.anthropicApiKey
  ? new Anthropic({ apiKey: config.anthropicApiKey })
  : new Anthropic();

export interface AskOptions {
  system?: string;
  /** Reasoning depth. `high` is the floor for anything diagnosis-critical. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Enable the server-side web search tool for research stages. */
  webSearch?: boolean;
}

/**
 * Ask Claude for a structured answer validated against a Zod schema.
 * Returns the parsed object, or throws if the model refused or produced
 * something unparseable — callers should not have to defend against silent nulls.
 */
export async function askStructured<T extends z.ZodType>(
  schema: T,
  prompt: string,
  options: AskOptions = {},
): Promise<z.infer<T>> {
  const response = await claude.messages.parse({
    model: config.model,
    max_tokens: options.maxTokens ?? 16_000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: options.effort ?? "high",
      format: zodOutputFormat(schema),
    },
    ...(options.system ? { system: options.system } : {}),
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      `Claude declined this request${
        response.stop_details && "category" in response.stop_details
          ? ` (${response.stop_details.category})`
          : ""
      }.`,
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "Response hit max_tokens before completing — raise maxTokens for this stage.",
    );
  }
  if (!response.parsed_output) {
    throw new Error("Claude returned no parseable structured output.");
  }
  return response.parsed_output;
}

/** Free-form ask with optional web search, for the research stage. */
export async function askText(prompt: string, options: AskOptions = {}): Promise<string> {
  const response = await claude.messages.create({
    model: config.model,
    max_tokens: options.maxTokens ?? 16_000,
    thinking: { type: "adaptive" },
    output_config: { effort: options.effort ?? "high" },
    ...(options.system ? { system: options.system } : {}),
    ...(options.webSearch
      ? { tools: [{ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 6 }] }
      : {}),
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined this research request.");
  }

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
