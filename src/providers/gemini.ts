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

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: GeminiUsage;
}

function endpoint(model: string): string {
  return `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(
    model
  )}:generateContent`;
}

function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey
  };
}

/** promptTokenCount includes cached tokens; report the uncached remainder. */
function mapUsage(usage: GeminiUsage | undefined): TokenUsage {
  const cachedInputTokens = usage?.cachedContentTokenCount ?? 0;
  const promptTokens = usage?.promptTokenCount ?? 0;
  return {
    inputTokens: Math.max(promptTokens - cachedInputTokens, 0),
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cachedInputTokens
  };
}

/**
 * Serialize normalized tool messages to Gemini `contents`. Gemini has no call
 * ids and matches results to calls by function name (and order), so we treat
 * the normalized `callId` as the function name.
 */
function toGeminiContents(messages: ToolMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "user") {
      return { role: "user", parts: [{ text: message.text }] };
    }
    if (message.role === "assistant") {
      const parts: unknown[] = [];
      if (message.text) {
        parts.push({ text: message.text });
      }
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.input } });
      }
      return { role: "model", parts };
    }
    return {
      role: "user",
      parts: message.results.map((result) => ({
        functionResponse: { name: result.callId, response: { result: result.content } }
      }))
    };
  });
}

/**
 * Complete a prompt using the stable Gemini REST `generateContent` endpoint.
 */
async function completeGemini(
  request: CompletionRequest,
  config: ProviderConfig
): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: request.prompt }] }],
    generationConfig: {
      maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
    }
  };

  if (request.system) {
    body.systemInstruction = { parts: [{ text: request.system }] };
  }

  const response = await fetch(endpoint(config.model), {
    method: "POST",
    headers: geminiHeaders(config.apiKey),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${detail}`);
  }

  const data = (await response.json()) as GeminiResponse;

  const text = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("");
  if (!text) {
    throw new Error("Gemini API returned no content");
  }

  return {
    text,
    provider: "gemini",
    model: config.model,
    usage: mapUsage(data.usageMetadata)
  };
}

/** Run one Gemini tool-use (function calling) turn. */
async function completeGeminiTools(
  request: ToolCompletionRequest,
  config: ProviderConfig
): Promise<ToolCompletionResult> {
  const body: Record<string, unknown> = {
    contents: toGeminiContents(request.messages),
    tools: [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }))
      }
    ],
    generationConfig: {
      maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
    }
  };

  if (request.system) {
    body.systemInstruction = { parts: [{ text: request.system }] };
  }

  const response = await fetch(endpoint(config.model), {
    method: "POST",
    headers: geminiHeaders(config.apiKey),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${detail}`);
  }

  const data = (await response.json()) as GeminiResponse;
  const parts = data.candidates?.[0]?.content?.parts ?? [];

  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const part of parts) {
    if (part.text) {
      text += part.text;
    } else if (part.functionCall) {
      // Gemini has no call id; use the function name as the correlation key.
      toolCalls.push({
        id: part.functionCall.name,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {}
      });
    }
  }

  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_use" : "end",
    provider: "gemini",
    model: config.model,
    usage: mapUsage(data.usageMetadata)
  };
}

/**
 * Google Gemini provider. The stable content goes in `systemInstruction` and the
 * volatile diff in `contents`; implicit context caching credits show up as
 * `cachedContentTokenCount`. (Explicit CachedContent objects are a later
 * optimization — out of scope for the base abstraction.)
 */
export const geminiProvider: Provider = {
  name: "gemini",
  complete: completeGemini,
  completeWithTools: completeGeminiTools
};
