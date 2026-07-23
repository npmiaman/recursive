import { z } from "zod";
import { config } from "../config.ts";
import { askStructured } from "../agents/claude.ts";
import { RateLimiter, withRetry, parseRetryAfter, type RetryableError } from "./ratelimit.ts";

/**
 * Model provider abstraction for the reasoning layer.
 *
 * Recursive's *fix* stage was already swappable (src/agents/fixers). Its
 * *reasoning* stages, query expansion, reranking, investigation, were not:
 * they called Claude directly. That's a real limitation, for a reason that has
 * nothing to do with preference:
 *
 *   The customers who most need Recursive to run inside their own network,
 * banks, regulated GCC work, run self-hosted models. Practically all of
 * those (Ollama, vLLM, LM Studio, TGI) expose an OpenAI-compatible endpoint.
 *   Hard-coding Anthropic meant those customers could self-host the code editor
 * but still had to send every reranking prompt to an external API, which
 * defeats the point.
 *
 * So the reasoning layer speaks to a provider interface. Anthropic remains the
 * default and the quality bar; the OpenAI-compatible path exists to reach
 * everything else, including models running on the customer's own hardware.
 */

// ---- tool-calling wire types (OpenAI-compatible) --------------------------

/** A message in an OpenAI-format chat, including tool calls and tool results. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface RawAssistantMessage extends ChatMessage {
  role: "assistant";
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

export interface AssistantTurn {
  content: string | null;
  toolCalls: { id: string; name: string; argumentsRaw: string }[];
  /** The raw assistant message, to append to history verbatim. */
  raw: ChatMessage;
}

export interface LLMProvider {
  readonly name: string;
  /** True if no request leaves the customer's network. */
  readonly selfHosted: boolean;
  /** Structured completion validated against a Zod schema. */
  structured<T extends z.ZodType>(
    schema: T,
    prompt: string,
    options?: { system?: string; maxTokens?: number; effort?: "low" | "medium" | "high" },
  ): Promise<z.infer<T>>;
  /** Cheap reachability check. Throws with actionable guidance if unusable. */
  preflight(): Promise<void>;
}

// ------------------------------------------------------------ Anthropic

class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly selfHosted = false;

  async structured<T extends z.ZodType>(
    schema: T,
    prompt: string,
    options: { system?: string; maxTokens?: number; effort?: "low" | "medium" | "high" } = {},
  ): Promise<z.infer<T>> {
    return askStructured(schema, prompt, options);
  }

  async preflight(): Promise<void> {
    // A bare client also resolves ANTHROPIC_AUTH_TOKEN and `ant auth login`
    // profiles, so an unset API key is not proof of no credentials.
    if (
      !process.env["ANTHROPIC_API_KEY"] &&
      !process.env["ANTHROPIC_AUTH_TOKEN"] &&
      !process.env["ANTHROPIC_PROFILE"]
    ) {
      throw new Error(
        "No Anthropic credentials found. Set ANTHROPIC_API_KEY in .env, run `ant auth login`, " +
          "or switch provider with LLM_PROVIDER=openai.",
      );
    }
  }
}

// ------------------------------------------------- OpenAI-compatible

/**
 * Any endpoint speaking the OpenAI chat-completions shape.
 *
 * Covers OpenAI itself, and, more importantly for us. Ollama, vLLM, LM Studio,
 * TGI and most on-prem serving stacks. Written against `fetch` rather than the
 * OpenAI SDK deliberately: one less dependency, and self-hosted endpoints
 * routinely implement only a subset of the SDK's assumptions.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly selfHosted: boolean;

  private baseUrl: string;
  private model: string;
  private apiKey: string | undefined;
  private limiter: RateLimiter;
  private maxRetries: number;

  constructor(settings: { baseUrl: string; model: string; apiKey?: string; rpm?: number; maxRetries?: number }) {
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
    this.model = settings.model;
    this.apiKey = settings.apiKey;
    // Pace and retry are how a free hosted tier (NVIDIA build.nvidia.com at
    // 40 RPM) becomes usable for a run that fires hundreds of requests. Both
    // default to inert (rpm 0 = no pacing) so nothing changes for Anthropic,
    // OpenAI proper, or a self-hosted model with its own limits.
    this.limiter = new RateLimiter(settings.rpm ?? 0);
    this.maxRetries = settings.maxRetries ?? 4;
    // Anything not pointed at api.openai.com is assumed to be the customer's
    // own infrastructure, which is the case this path mainly exists for.
    this.selfHosted = !/api\.openai\.com/.test(this.baseUrl);
    this.name = this.selfHosted ? `openai-compatible (${this.baseUrl})` : "openai";
  }

  /**
   * One turn of a tool-calling conversation.
   *
   * This is the primitive the agentic coding loop is built on. Unlike
   * `structured()`, which is a single request/response, this takes the whole
   * running message history plus the tool schemas and returns the model's next
   * move: either final text, or a batch of tool calls to execute. The loop that
   * drives it lives in src/agents/coding.
   *
   * Deliberately on the OpenAI-compatible class rather than the LLMProvider
   * interface: tool-calling wire formats differ between vendors, and the agentic
   * engine already requires an OpenAI-compatible endpoint (which is what NVIDIA,
   * Ollama, vLLM and OpenAI all speak).
   */
  async toolChat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    options: { maxTokens?: number } = {},
  ): Promise<AssistantTurn> {
    const payload = await withRetry(
      async () => {
        await this.limiter.acquire();
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            tools,
            tool_choice: "auto",
            max_tokens: options.maxTokens ?? 8000,
          }),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const error: RetryableError = new Error(
            `${this.name} returned ${response.status}: ${body.slice(0, 300)}`,
          );
          error.status = response.status;
          error.retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
          throw error;
        }
        return (await response.json()) as {
          choices?: { message?: RawAssistantMessage }[];
        };
      },
      { maxRetries: this.maxRetries },
    );

    const message = payload.choices?.[0]?.message;
    return {
      content: message?.content ?? null,
      toolCalls: (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        // Arguments arrive as a JSON string; leave parsing to the caller so a
        // malformed call can be reported back to the model rather than crashing.
        argumentsRaw: call.function.arguments ?? "{}",
      })),
      // Round-trip the raw message so the caller can append it verbatim, which
      // is required: the follow-up tool results must reference the exact
      // tool_call ids the model emitted.
      raw: message ?? { role: "assistant", content: "" },
    };
  }

  async structured<T extends z.ZodType>(
    schema: T,
    prompt: string,
    options: { system?: string; maxTokens?: number } = {},
  ): Promise<z.infer<T>> {
    // Zod v4 emits JSON Schema natively, so the same schema drives both providers.
    const jsonSchema = z.toJSONSchema(schema, { io: "output" });

    const messages: { role: string; content: string }[] = [];
    if (options.system) messages.push({ role: "system", content: options.system });
    messages.push({
      role: "user",
      content:
        prompt +
        // Belt and braces: many self-hosted servers accept `response_format` but
        // ignore it, so the instruction has to be in the prompt too.
        `\n\nRespond with ONLY a JSON object matching this schema. No prose, no code fence.\n` +
        JSON.stringify(jsonSchema),
    });

    const payload = await withRetry(
      async () => {
        // Pace INSIDE the retried function so a retry also waits for its slot,
        // rather than a backing-off worker jumping the queue on its next try.
        await this.limiter.acquire();

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            max_tokens: options.maxTokens ?? 4000,
            response_format: { type: "json_object" },
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const error: RetryableError = new Error(
            `${this.name} returned ${response.status}: ${body.slice(0, 300)}`,
          );
          error.status = response.status;
          // NVIDIA and most gateways send Retry-After on a 429; honour it
          // rather than guessing a backoff.
          error.retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
          throw error;
        }

        return (await response.json()) as { choices?: { message?: { content?: string } }[] };
      },
      { maxRetries: this.maxRetries },
    );

    const text = payload.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${this.name} returned no content.`);

    // Smaller and self-hosted models wrap JSON in fences or prose despite
    // instructions. Extract the outermost object rather than failing outright.
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const candidate = start !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned;

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      throw new Error(`${this.name} returned unparseable JSON: ${cleaned.slice(0, 200)}`);
    }

    return schema.parse(parsed);
  }

  async preflight(): Promise<void> {
    if (!this.apiKey && !this.selfHosted) {
      throw new Error(
        "LLM_PROVIDER=openai but OPENAI_API_KEY is not set. Put it in .env, never in a chat message.",
      );
    }
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 401) {
        throw new Error(`${this.name} rejected the credentials (401). Check OPENAI_API_KEY.`);
      }
    } catch (error) {
      if (error instanceof Error && /rejected the credentials/.test(error.message)) throw error;
      throw new Error(
        `Could not reach ${this.baseUrl} (${error instanceof Error ? error.message : error}). ` +
          `For a self-hosted model, confirm it is running and OPENAI_BASE_URL points at it.`,
      );
    }
  }
}

// ------------------------------------------------------------ resolution

let cached: LLMProvider | undefined;

export function resolveProvider(): LLMProvider {
  if (cached) return cached;

  if (config.llmProvider === "openai") {
    cached = new OpenAICompatibleProvider({
      baseUrl: config.openAiBaseUrl,
      model: config.openAiModel,
      apiKey: process.env["OPENAI_API_KEY"],
      rpm: config.openAiRpm,
      maxRetries: config.openAiMaxRetries,
    });
  } else {
    cached = new AnthropicProvider();
  }
  return cached;
}

/** Test seam, lets a caller inject a provider without touching env. */
export function setProvider(provider: LLMProvider | undefined): void {
  cached = provider;
}

export function describeProvider(): { name: string; selfHosted: boolean; model: string } {
  const provider = resolveProvider();
  return {
    name: provider.name,
    selfHosted: provider.selfHosted,
    model: config.llmProvider === "openai" ? config.openAiModel : config.model,
  };
}
