/**
 * Provider abstraction for prowl-review.
 *
 * BYOK, multi-provider (Claude default / OpenAI / Gemini), built on raw `fetch`
 * with no heavy SDKs — mirroring `prowl`'s `src/generator/ai.ts` and extending it
 * with prompt caching and token/usage accounting.
 */

export type ProviderName = "anthropic" | "openai" | "gemini" | "codex";

export const PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai", "gemini", "codex"];

/**
 * Providers that authenticate through a locally installed, first-party CLI/login
 * rather than a BYOK API key. `codex` spawns the official `codex` binary signed in
 * with ChatGPT, so it carries **no** `apiKey` and `resolveProviderConfig` /
 * ensemble resolution must not require one (backlog #45).
 */
export const KEYLESS_PROVIDERS: readonly ProviderName[] = ["codex"];

/** True when a provider authenticates via a local CLI login instead of a BYOK key (#45). */
export function isKeylessProvider(provider: ProviderName): boolean {
  return (KEYLESS_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Default model per provider. Overridable via `PROWL_AI_MODEL`. These track the
 * built-in review defaults at time of writing and should be revisited as providers
 * ship new versions; BYOK users can always override without a release.
 */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  // Haiku is the default to keep out-of-box reviews cheap and fast. This is a
  // cost/latency/context-window trade-off; pin a per-provider `model` (e.g.
  // claude-sonnet-4-6) for maximum-fidelity, large-PR, or eval-gated deployments.
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5.4-mini",
  gemini: "gemini-2.5-pro",
  // Codex draws from the ChatGPT plan allowance. `gpt-5.4`/`gpt-5.4-mini` leave
  // ChatGPT sign-in 2026-08-31, so the default is `gpt-5.5` (failback ladder in
  // `failback.ts`: gpt-5.6-terra → gpt-5.5).
  codex: "gpt-5.5"
};

/**
 * Codex-only knobs threaded onto {@link ProviderConfig} (backlog #45). Ignored by
 * every other provider. `resolveProviderConfig` populates these from env/config
 * for `codex`; direct callers/tests may set them explicitly.
 */
export interface CodexOptions {
  /**
   * Reasoning effort passed as `model_reasoning_effort` (`minimal` | `low` |
   * `medium` | `high`). Default `low` — cost-first, matching the specialist
   * fan-out that dominates a review. `complete()` carries no pass identity, so a
   * single effort applies to every pass; a per-pass (judge/verification) bump is
   * a follow-up.
   */
  effort?: string;
  /**
   * Serialize `codex` spawns machine-wide via an advisory file lock at
   * `$CODEX_HOME/.prowl-review.lock`. Default true — OpenAI requires one
   * `auth.json` per serialized stream, and #64 runs several runner instances
   * against one `CODEX_HOME`. Opt out only when a single instance owns the host.
   */
  lock?: boolean;
  /**
   * Override `CODEX_HOME` (where the `codex` binary reads `auth.json` and where
   * the lock lives). Defaults to `$CODEX_HOME` or `~/.codex`. prowl-review never
   * reads, copies, or logs `auth.json` — only the `codex` binary does.
   */
  codexHome?: string;
}

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  /**
   * Secret provider credential. Do not log or serialize. Configs returned by the
   * built-in resolvers install JSON/inspect redaction hooks, while still exposing
   * the raw string for provider request headers. Empty for keyless providers
   * (e.g. `codex`, which authenticates via the local `codex login`).
   */
  apiKey: string;
  /** Codex-only options (effort, lock, CODEX_HOME); ignored by other providers (#45). */
  codex?: CodexOptions;
}

export interface RedactedProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey: "<redacted>";
}

const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

/** Return a non-secret view of a provider config for logs and serialization. */
export function redactedProviderConfig(config: ProviderConfig): RedactedProviderConfig {
  return { provider: config.provider, model: config.model, apiKey: "<redacted>" };
}

/** Install best-effort redaction hooks on resolver-created provider configs. */
export function protectProviderConfig<T extends ProviderConfig>(config: T): T {
  const redacted = () => redactedProviderConfig(config);
  Object.defineProperty(config, "apiKey", {
    value: config.apiKey,
    enumerable: false,
    writable: true,
    configurable: true
  });
  Object.defineProperty(config, "toJSON", { value: redacted, enumerable: false, configurable: true });
  Object.defineProperty(config, INSPECT_CUSTOM, { value: redacted, enumerable: false, configurable: true });
  return config;
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
  /**
   * Request native JSON output where the provider supports it (#7). Our review
   * passes emit a top-level JSON array, so each provider uses the technique that
   * constrains it natively: Anthropic prefills the assistant turn with `[`;
   * Gemini sets `responseMimeType: application/json`. OpenAI has no
   * array-compatible native mode (`json_object` / strict `json_schema` both
   * require an object root), so it falls back to the prompt contract plus the
   * caller's parse-and-retry. Unset = plain text.
   */
  responseFormat?: "json";
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
