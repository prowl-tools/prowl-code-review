import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderConfig,
  type TokenUsage,
  type ToolCall,
  type ToolCompletionRequest,
  type ToolCompletionResult,
  type ToolProviderMetadata,
  type GeminiToolMessagePart,
  type ToolMessage
} from "./types.js";

interface GeminiPart {
  text?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  /** Gemini thinking signature that must be echoed back on the same ordered part. */
  thoughtSignature?: string;
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsage;
}

/**
 * Output budget for Gemini. Larger than the shared {@link DEFAULT_MAX_TOKENS}
 * because Gemini 2.5 "thinking" tokens count against `maxOutputTokens`: on a
 * full review prompt the 4096 default was being consumed entirely by thinking,
 * leaving zero tokens for the answer (an empty response → "no content").
 */
const GEMINI_MAX_OUTPUT_TOKENS = 8192;

/** Cap thinking so the remainder of the budget is guaranteed for the answer. */
const GEMINI_THINKING_BUDGET = 2048;

/**
 * Reviewing vulnerability/secret code (SQL injection, leaked keys, …) is the job;
 * don't let safety filters blank the response. Set all categories to BLOCK_NONE
 * so a legitimate security review isn't silently refused (`finishReason: SAFETY`).
 */
const GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
] as const;

/** Gemini 2.5+ are thinking models; older lines reject an unknown `thinkingConfig`. */
function supportsThinking(model: string): boolean {
  return /gemini-(2\.5|[3-9])/i.test(model);
}

/**
 * Build `generationConfig` shared by the text and tool paths: a larger output
 * budget plus a bounded thinking budget on models that support it.
 */
function buildGenerationConfig(
  model: string,
  maxTokens: number | undefined,
  temperature: number | undefined
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: maxTokens ?? GEMINI_MAX_OUTPUT_TOKENS,
    ...(temperature !== undefined ? { temperature } : {})
  };
  if (supportsThinking(model)) {
    generationConfig.thinkingConfig = { thinkingBudget: GEMINI_THINKING_BUDGET };
  }
  return generationConfig;
}

/** Build a diagnostic suffix from a response that yielded no usable text. */
function noContentDetail(data: GeminiResponse): string {
  const reason = data.candidates?.[0]?.finishReason;
  const blocked = data.promptFeedback?.blockReason;
  const parts = [
    reason ? `finishReason: ${reason}` : "",
    blocked ? `blockReason: ${blocked}` : ""
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function endpoint(model: string): string {
  // v1beta serves the current Gemini models (the 2.x line); v1 lags and 404s
  // on them. The AI Studio (generativelanguage) API documents v1beta for
  // generateContent.
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
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
 * Serialize normalized tool messages to Gemini `contents`. Gemini 3 returns
 * function-call ids; older responses may omit them, so name is the fallback key.
 */
function toGeminiContents(messages: ToolMessage[]): unknown[] {
  const toolNamesById = new Map<string, string>();

  return messages.map((message) => {
    if (message.role === "user") {
      return { role: "user", parts: [{ text: message.text }] };
    }
    if (message.role === "assistant") {
      const parts =
        message.providerMetadata?.geminiParts
          ? message.providerMetadata.geminiParts.map((part) => {
              if (part.type === "text") {
                return {
                  text: part.text,
                  ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
                };
              }
              toolNamesById.set(part.id, part.name);
              return {
                functionCall: {
                  ...(part.id !== part.name ? { id: part.id } : {}),
                  name: part.name,
                  args: part.input
                },
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
              };
            })
          : normalizedGeminiAssistantParts(message.text, message.toolCalls, toolNamesById);
      return { role: "model", parts };
    }
    return {
      role: "user",
      parts: message.results.map((result) => {
        const name = toolNamesById.get(result.callId) ?? result.callId;
        return {
          functionResponse: {
            ...(result.callId !== name ? { id: result.callId } : {}),
            name,
            response: { result: result.content }
          }
        };
      })
    };
  });
}

function normalizedGeminiAssistantParts(
  text: string,
  toolCalls: ToolCall[],
  toolNamesById: Map<string, string>
): unknown[] {
  const parts: unknown[] = [];
  if (text) {
    parts.push({ text });
  }
  for (const call of toolCalls) {
    toolNamesById.set(call.id, call.name);
    parts.push({
      functionCall: {
        ...(call.id !== call.name ? { id: call.id } : {}),
        name: call.name,
        args: call.input
      },
      ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
    });
  }
  return parts;
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
    generationConfig: buildGenerationConfig(config.model, request.maxTokens, request.temperature),
    safetySettings: GEMINI_SAFETY_SETTINGS
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
    const detail = (await response.text()) || "(no response body)";
    const hint =
      response.status === 404
        ? ` — model "${config.model}" may be unavailable for this key; set PROWL_AI_MODEL / ai-model to a model your key supports.`
        : "";
    throw new Error(`Gemini API error (${response.status}): ${detail}${hint}`);
  }

  const data = (await response.json()) as GeminiResponse;

  const text = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("");
  if (!text) {
    // Surface the reason (e.g. MAX_TOKENS from thinking, or SAFETY) instead of a
    // generic message, so a degraded run is diagnosable rather than mysterious.
    throw new Error(`Gemini API returned no content${noContentDetail(data)}`);
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
    generationConfig: buildGenerationConfig(config.model, request.maxTokens, request.temperature),
    safetySettings: GEMINI_SAFETY_SETTINGS
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
    const detail = (await response.text()) || "(no response body)";
    const hint =
      response.status === 404
        ? ` — model "${config.model}" may be unavailable for this key; set PROWL_AI_MODEL / ai-model to a model your key supports.`
        : "";
    throw new Error(`Gemini API error (${response.status}): ${detail}${hint}`);
  }

  const data = (await response.json()) as GeminiResponse;
  const parts = data.candidates?.[0]?.content?.parts ?? [];

  let text = "";
  const toolCalls: ToolCall[] = [];
  const geminiParts: GeminiToolMessagePart[] = [];
  for (const part of parts) {
    if (part.text !== undefined) {
      text += part.text;
      geminiParts.push({
        type: "text",
        text: part.text,
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
      });
    } else if (part.functionCall) {
      const toolCall = {
        id: part.functionCall.id ?? part.functionCall.name,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
      };
      toolCalls.push(toolCall);
      geminiParts.push({
        type: "functionCall",
        ...toolCall
      });
    }
  }
  const providerMetadata: ToolProviderMetadata | undefined =
    geminiParts.some((part) => part.thoughtSignature) ? { geminiParts } : undefined;

  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_use" : "end",
    providerMetadata,
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
