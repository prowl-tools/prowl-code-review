import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderConfig,
  DEFAULT_MAX_TOKENS
} from "./types.js";

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Anthropic (Claude) provider. Uses explicit `cache_control` on the system block
 * so the stable prompt prefix is cached (GA prompt caching — no beta header).
 */
export const anthropicProvider: Provider = {
  name: "anthropic",

  async complete(request: CompletionRequest, config: ProviderConfig): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: "user", content: request.prompt }]
    };

    if (request.system) {
      // Mark the system block ephemeral so it is cached and re-read cheaply on
      // subsequent reviews of the same PR (only the diff in `prompt` is uncached).
      body.system = [
        { type: "text", text: request.system, cache_control: { type: "ephemeral" } }
      ];
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${detail}`);
    }

    const data = (await response.json()) as AnthropicResponse;

    const text = data.content.find((block) => block.type === "text")?.text;
    if (!text) {
      throw new Error("Anthropic API returned no text content");
    }

    return {
      text,
      provider: "anthropic",
      model: config.model,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        cachedInputTokens: data.usage?.cache_read_input_tokens ?? 0
      }
    };
  }
};
