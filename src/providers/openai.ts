import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderConfig,
  DEFAULT_MAX_TOKENS
} from "./types.js";

interface OpenAiResponse {
  choices: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * OpenAI provider. Prompt caching is automatic for sufficiently long, stable
 * prefixes — no markers needed — so we put the cacheable content first as the
 * system message and the volatile diff as the user message.
 */
export const openaiProvider: Provider = {
  name: "openai",

  /** Complete a prompt using OpenAI Chat Completions with stable-prefix caching. */
  async complete(request: CompletionRequest, config: ProviderConfig): Promise<CompletionResult> {
    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) {
      messages.push({ role: "system", content: request.system });
    }
    messages.push({ role: "user", content: request.prompt });

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${detail}`);
    }

    const data = (await response.json()) as OpenAiResponse;

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("OpenAI API returned no content");
    }

    const cachedInputTokens = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const promptTokens = data.usage?.prompt_tokens ?? 0;

    return {
      text,
      provider: "openai",
      model: config.model,
      usage: {
        // prompt_tokens includes cached tokens; report the uncached remainder.
        inputTokens: Math.max(promptTokens - cachedInputTokens, 0),
        outputTokens: data.usage?.completion_tokens ?? 0,
        cachedInputTokens
      }
    };
  }
};
