import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderConfig,
  DEFAULT_MAX_TOKENS
} from "./types.js";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
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

  async complete(request: CompletionRequest, config: ProviderConfig): Promise<CompletionResult> {
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      config.model
    )}:generateContent`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.apiKey
      },
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

    const cachedInputTokens = data.usageMetadata?.cachedContentTokenCount ?? 0;
    const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;

    return {
      text,
      provider: "gemini",
      model: config.model,
      usage: {
        // promptTokenCount includes cached tokens; report the uncached remainder.
        inputTokens: Math.max(promptTokens - cachedInputTokens, 0),
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        cachedInputTokens
      }
    };
  }
};
