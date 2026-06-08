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

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAiToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface OpenAiResponse {
  choices: Array<{
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string;
  }>;
  usage?: OpenAiUsage;
}

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

function openaiHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}

/** prompt_tokens includes cached tokens; report the uncached remainder. */
function mapUsage(usage: OpenAiUsage | undefined): TokenUsage {
  const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const promptTokens = usage?.prompt_tokens ?? 0;
  return {
    inputTokens: Math.max(promptTokens - cachedInputTokens, 0),
    outputTokens: usage?.completion_tokens ?? 0,
    cachedInputTokens
  };
}

/** Serialize normalized tool messages to OpenAI chat messages. */
function toOpenAiMessages(system: string | undefined, messages: ToolMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) {
    out.push({ role: "system", content: system });
  }
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.text });
    } else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.text || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input) }
        }))
      });
    } else {
      for (const result of message.results) {
        out.push({ role: "tool", tool_call_id: result.callId, content: result.content });
      }
    }
  }
  return out;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Complete a prompt using OpenAI Chat Completions with stable-prefix caching.
 */
async function completeOpenAi(
  request: CompletionRequest,
  config: ProviderConfig
): Promise<CompletionResult> {
  const messages: Array<{ role: string; content: string }> = [];
  if (request.system) {
    messages.push({ role: "system", content: request.system });
  }
  messages.push({ role: "user", content: request.prompt });

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_completion_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS
  };

  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: openaiHeaders(config.apiKey),
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

  return {
    text,
    provider: "openai",
    model: config.model,
    usage: mapUsage(data.usage)
  };
}

/** Run one OpenAI tool-use (function calling) turn. */
async function completeOpenAiTools(
  request: ToolCompletionRequest,
  config: ProviderConfig
): Promise<ToolCompletionResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: toOpenAiMessages(request.system, request.messages),
    max_completion_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    tools: request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }))
  };

  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: openaiHeaders(config.apiKey),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${detail}`);
  }

  const data = (await response.json()) as OpenAiResponse;
  const choice = data.choices?.[0];
  const rawCalls = choice?.message?.tool_calls ?? [];
  const toolCalls: ToolCall[] = rawCalls.map((call) => ({
    id: call.id,
    name: call.function.name,
    input: parseArguments(call.function.arguments)
  }));

  return {
    text: choice?.message?.content ?? "",
    toolCalls,
    stopReason: choice?.finish_reason === "tool_calls" || toolCalls.length > 0 ? "tool_use" : "end",
    provider: "openai",
    model: config.model,
    usage: mapUsage(data.usage)
  };
}

/**
 * OpenAI provider. Prompt caching is automatic for sufficiently long, stable
 * prefixes — no markers needed — so we put the cacheable content first as the
 * system message and the volatile diff as the user message.
 */
export const openaiProvider: Provider = {
  name: "openai",
  complete: completeOpenAi,
  completeWithTools: completeOpenAiTools
};
