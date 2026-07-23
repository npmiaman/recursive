import { z } from "zod";
import { config } from "../config.ts";
import { askStructured } from "../agents/claude.ts";

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
class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly selfHosted: boolean;

  private baseUrl: string;
  private model: string;
  private apiKey: string | undefined;

  constructor(settings: { baseUrl: string; model: string; apiKey?: string }) {
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
    this.model = settings.model;
    this.apiKey = settings.apiKey;
    // Anything not pointed at api.openai.com is assumed to be the customer's
    // own infrastructure, which is the case this path mainly exists for.
    this.selfHosted = !/api\.openai\.com/.test(this.baseUrl);
    this.name = this.selfHosted ? `openai-compatible (${this.baseUrl})` : "openai";
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
      throw new Error(`${this.name} returned ${response.status}: ${body.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
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
