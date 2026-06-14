/**
 * Provider abstraction for prowl-review.
 *
 * BYOK, multi-provider (Claude default / OpenAI / Gemini), built on raw `fetch`
 * with no heavy SDKs — mirroring `prowl`'s `src/generator/ai.ts` and extending it
 * with prompt caching and token/usage accounting.
 */

export type ProviderName = "anthropic" | "openai" | "gemini";

export const PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai", "gemini"];

/**
 * Default model per provider. Overridable via `PROWL_AI_MODEL`. These track the
 * current flagship at time of writing and should be bumped as providers ship new
 * versions; BYOK users can always override without a release.
 */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.2",
  gemini: "gemini-2.5-pro"
};

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
}

export interface CompletionRequest {
  /**
   * Stable, cacheable content — system prompt, review guidelines, fetched repo
   * context, tool defs. Cached where the provider supports it (Anthropic via
   * explicit `cache_control`; OpenAI/Gemini via automatic prefix caching), so
   * re-reviews of the same PR pay a fraction of the input cost.
   */
  system?: string;
  /** Volatile content (e.g. the diff). Never cached. */
  prompt: string;
  /** Max output tokens. Defaults to {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number;
  /** Sampling temperature. Provider default when omitted. */
  temperature?: number;
}

export interface TokenUsage {
  /** Uncached input tokens (billed at full rate). */
  inputTokens: number;
  /** Billed generated response tokens, including provider-reported thinking tokens when applicable. */
  outputTokens: number;
  /** Input tokens served from cache (billed at the discounted read rate). */
  cachedInputTokens: number;
  /** Input tokens written to a provider cache, when reported separately. */
  cacheWriteInputTokens?: number;
}

export interface CompletionResult {
  text: string;
  usage: TokenUsage;
  provider: ProviderName;
  model: string;
}

// ---------------------------------------------------------------------------
// Tool use (function calling) — used by agentic cross-file context retrieval.
// A single normalized representation is serialized per provider so the loop
// driver stays provider-agnostic.
// ---------------------------------------------------------------------------

/** A tool the model may call, described with a JSON-Schema input. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool input object. */
  parameters: Record<string, unknown>;
}

/** A model request to invoke a tool. */
export interface ToolCall {
  /** Provider-assigned id used to correlate the result. */
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Opaque Gemini "thought signature" returned on a function call. Gemini 3.x
   * requires it to be echoed back on the same call in later turns, so it must
   * round-trip through the conversation. Unused by other providers.
   */
  thoughtSignature?: string;
}

/** The result of executing a {@link ToolCall}, fed back to the model. */
export interface ToolResult {
  callId: string;
  content: string;
}

export type GeminiToolMessagePart =
  | { type: "text"; text: string; thoughtSignature?: string }
  | {
      type: "functionCall";
      id: string;
      name: string;
      input: Record<string, unknown>;
      thoughtSignature?: string;
    };

export interface ToolProviderMetadata {
  /** Ordered Gemini parts to preserve opaque thinking signatures across turns. */
  geminiParts?: GeminiToolMessagePart[];
}

/** One turn in a tool-use conversation, normalized across providers. */
export type ToolMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; providerMetadata?: ToolProviderMetadata }
  | { role: "tool"; results: ToolResult[] };

export interface ToolCompletionRequest {
  /** Stable, cacheable instruction/context. */
  system?: string;
  /** Conversation so far. */
  messages: ToolMessage[];
  /** Tools the model may call this turn. */
  tools: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface ToolCompletionResult {
  /** Any assistant text emitted alongside tool calls. */
  text: string;
  /** Tool calls the model wants executed (empty when it is done). */
  toolCalls: ToolCall[];
  /** `tool_use` when the model wants tools run; `end` when it is finished. */
  stopReason: "tool_use" | "end";
  /** Provider-specific state that must round-trip with the next assistant turn. */
  providerMetadata?: ToolProviderMetadata;
  usage: TokenUsage;
  provider: ProviderName;
  model: string;
}

export interface Provider {
  readonly name: ProviderName;
  /** Run the provider-specific completion call and normalize token usage data. */
  complete(request: CompletionRequest, config: ProviderConfig): Promise<CompletionResult>;
  /** Run one tool-use turn (function calling), normalized across providers. */
  completeWithTools(
    request: ToolCompletionRequest,
    config: ProviderConfig
  ): Promise<ToolCompletionResult>;
}

export const DEFAULT_MAX_TOKENS = 4096;

/** Empty usage record, used as a safe fallback when a provider omits usage data. */
export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}
