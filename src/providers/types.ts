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
  /** Generated output tokens. */
  outputTokens: number;
  /** Input tokens served from cache (billed at the discounted read rate). */
  cachedInputTokens: number;
}

export interface CompletionResult {
  text: string;
  usage: TokenUsage;
  provider: ProviderName;
  model: string;
}

export interface Provider {
  readonly name: ProviderName;
  complete(request: CompletionRequest, config: ProviderConfig): Promise<CompletionResult>;
}

export const DEFAULT_MAX_TOKENS = 4096;

/** Empty usage record, used as a safe fallback when a provider omits usage data. */
export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}
