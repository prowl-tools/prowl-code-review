import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderConfig,
  type TokenUsage,
  type ToolCall,
  type ToolCompletionRequest,
  type ToolCompletionResult,
  type ToolMessage,
  DEFAULT_MAX_TOKENS
} from "./types.js";

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content: AnthropicBlock[];
  stop_reason?: string;
  usage?: AnthropicUsage;
}

const ENDPOINT = "https://api.anthropic.com/v1/messages";

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  };
}

/** Cache creation tokens are billed near full rate, so fold them into input. */
function mapUsage(usage: AnthropicUsage | undefined): TokenUsage {
  const inputTokens = usage?.input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: inputTokens + cacheWrite,
    outputTokens: usage?.output_tokens ?? 0,
    cachedInputTokens: usage?.cache_read_input_tokens ?? 0
  };
}

/** A cached, ephemeral system block (only set when system text is present). */
function systemBlocks(system: string | undefined): unknown {
  return system
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : undefined;
}

/** Serialize normalized tool messages to Anthropic content blocks. */
function toAnthropicMessages(messages: ToolMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "user") {
      return { role: "user", content: [{ type: "text", text: message.text }] };
    }
    if (message.role === "assistant") {
      const content: unknown[] = [];
      if (message.text) {
        content.push({ type: "text", text: message.text });
      }
      for (const call of message.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      return { role: "assistant", content };
    }
    return {
      role: "user",
      content: message.results.map((result) => ({
        type: "tool_result",
        tool_use_id: result.callId,
        content: result.content
      }))
    };
  });
}

/**
 * Complete a prompt using Anthropic Messages with explicit `cache_control` on
 * the stable system block.
 */
async function completeAnthropic(
  request: CompletionRequest,
  config: ProviderConfig
): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [{ role: "user", content: request.prompt }]
  };

  const system = systemBlocks(request.system);
  if (system) {
    body.system = system;
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: anthropicHeaders(config.apiKey),
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
    usage: mapUsage(data.usage)
  };
}

/** Run one Anthropic tool-use turn. */
async function completeAnthropicTools(
  request: ToolCompletionRequest,
  config: ProviderConfig
): Promise<ToolCompletionResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: toAnthropicMessages(request.messages),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }))
  };

  const system = systemBlocks(request.system);
  if (system) {
    body.system = system;
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: anthropicHeaders(config.apiKey),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${detail}`);
  }

  const data = (await response.json()) as AnthropicResponse;

  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text" && block.text) {
      text += block.text;
    } else if (block.type === "tool_use" && block.id && block.name) {
      toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }
  }

  return {
    text,
    toolCalls,
    stopReason: data.stop_reason === "tool_use" ? "tool_use" : "end",
    provider: "anthropic",
    model: config.model,
    usage: mapUsage(data.usage)
  };
}

/**
 * Anthropic (Claude) provider. Uses explicit `cache_control` on the system block
 * so the stable prompt prefix is cached (GA prompt caching — no beta header).
 */
export const anthropicProvider: Provider = {
  name: "anthropic",
  complete: completeAnthropic,
  completeWithTools: completeAnthropicTools
};
