import { OpenAICompatibleProvider, resolveProvider, type ChatMessage } from "../../llm/provider.ts";
import { TOOL_SPECS, runTool, type ToolContext } from "./tools.ts";

/**
 * The agentic coding loop, modelled on how Claude Code actually runs.
 *
 * The shape is the same one every tool-using agent uses:
 *
 *   1. Seed the conversation with a system brief and the task.
 *   2. Ask the model for its next move.
 *   3. If it returned tool calls, execute each against the repo and append the
 *      results to the conversation. Go to 2.
 *   4. If it returned plain text or called `finish`, stop.
 *
 * The context store IS the `messages` array: it accumulates the task, every
 * tool call the model made, and every result it got back, so the model always
 * sees the full trail of what it has already looked at and changed. That is what
 * lets it grep, read, edit, run the tests, see them fail, and edit again, rather
 * than fixing blind in one shot.
 *
 * Two bounds keep it honest: a turn cap (so a confused model cannot loop
 * forever) and token-budget compaction (so a long session does not overflow the
 * context window). Compaction elides the *middle* of the transcript, never the
 * system brief or the most recent turns, because those are what the model needs
 * to keep going.
 */

export interface CodingAgentResult {
  status: "completed" | "stopped" | "error";
  summary: string;
  filesChanged: string[];
  turns: number;
  toolCalls: number;
  transcript: string[];
}

export interface CodingAgentOptions {
  repoPath: string;
  task: string;
  system: string;
  maxTurns?: number;
  /** Rough token ceiling for the running conversation before compaction. */
  contextBudgetTokens?: number;
  onEvent?: (line: string) => void;
}

/** Cheap token estimate. Chars/4 is close enough to pace compaction. */
function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length;
    for (const call of m.tool_calls ?? []) chars += call.function.arguments.length + call.function.name.length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Shrink the conversation when it grows too large.
 *
 * Keeps the system message and the task (first two), keeps the most recent
 * `keepRecent` messages intact, and replaces the tool RESULTS in between with a
 * short placeholder. Tool results are the bulky part (whole files, command
 * output) and the least necessary to retain verbatim once acted on. The
 * assistant's own reasoning and tool calls are left in place so the thread of
 * intent survives.
 */
function compact(messages: ChatMessage[], keepRecent = 8): ChatMessage[] {
  if (messages.length <= keepRecent + 2) return messages;
  const head = messages.slice(0, 2);
  const tail = messages.slice(-keepRecent);
  const middle = messages.slice(2, -keepRecent).map((m): ChatMessage => {
    if (m.role === "tool" && (m.content?.length ?? 0) > 200) {
      return { ...m, content: "[earlier tool output elided to save context]" };
    }
    return m;
  });
  return [...head, ...middle, ...tail];
}

export async function runCodingAgent(options: CodingAgentOptions): Promise<CodingAgentResult> {
  const provider = resolveProvider();
  if (!(provider instanceof OpenAICompatibleProvider)) {
    return {
      status: "error",
      summary:
        "The agentic engine needs an OpenAI-compatible provider (set LLM_PROVIDER=openai and OPENAI_BASE_URL, e.g. a NVIDIA endpoint).",
      filesChanged: [],
      turns: 0,
      toolCalls: 0,
      transcript: [],
    };
  }

  const maxTurns = options.maxTurns ?? 40;
  const budget = options.contextBudgetTokens ?? 120_000;
  const ctx: ToolContext = {
    repoPath: options.repoPath,
    filesRead: new Set(),
    filesWritten: new Set(),
    onEvent: options.onEvent,
  };
  const transcript: string[] = [];

  let messages: ChatMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.task },
  ];

  let toolCallCount = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (estimateTokens(messages) > budget) {
      messages = compact(messages);
      options.onEvent?.("(context compacted)");
    }

    let assistant;
    try {
      assistant = await provider.toolChat(messages, TOOL_SPECS, { maxTokens: 8000 });
    } catch (error) {
      return {
        status: "error",
        summary: `model call failed on turn ${turn}: ${error instanceof Error ? error.message : error}`,
        filesChanged: [...ctx.filesWritten],
        turns: turn,
        toolCalls: toolCallCount,
        transcript,
      };
    }

    // Append the assistant's message verbatim, so the tool results that follow
    // reference the exact tool_call ids it emitted.
    messages.push(assistant.raw);
    if (assistant.content) transcript.push(`[think] ${assistant.content.slice(0, 300)}`);

    // No tool calls means the model is done talking. Treat as completion.
    if (assistant.toolCalls.length === 0) {
      return {
        status: "completed",
        summary: assistant.content ?? "Done.",
        filesChanged: [...ctx.filesWritten],
        turns: turn,
        toolCalls: toolCallCount,
        transcript,
      };
    }

    for (const call of assistant.toolCalls) {
      toolCallCount++;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.argumentsRaw) as Record<string, unknown>;
      } catch {
        messages.push(toolResult(call.id, "error: arguments were not valid JSON"));
        continue;
      }

      if (call.name === "finish") {
        options.onEvent?.("finish");
        return {
          status: "completed",
          summary: String(args["summary"] ?? "Fix complete."),
          filesChanged: [...ctx.filesWritten],
          turns: turn,
          toolCalls: toolCallCount,
          transcript,
        };
      }

      const result = runTool(ctx, call.name, args);
      transcript.push(`[${call.name}] ${summarizeArgs(call.name, args)} -> ${result.slice(0, 120)}`);
      messages.push(toolResult(call.id, result));
    }
  }

  return {
    status: "stopped",
    summary: `Reached the ${maxTurns}-turn limit without calling finish. Files changed: ${[...ctx.filesWritten].join(", ") || "none"}.`,
    filesChanged: [...ctx.filesWritten],
    turns: maxTurns,
    toolCalls: toolCallCount,
    transcript,
  };
}

function toolResult(id: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content };
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  if (name === "read_file" || name === "write_file" || name === "edit_file") return String(args["path"] ?? "");
  if (name === "search") return String(args["query"] ?? "");
  if (name === "run_command") return String(args["command"] ?? "");
  return "";
}
