import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import { geminiProvider } from "./gemini.js";
import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderConfig,
  type ProviderName,
  type ToolCompletionRequest,
  type ToolCompletionResult,
  DEFAULT_MODELS,
  PROVIDER_NAMES,
  protectProviderConfig
} from "./types.js";

export * from "./types.js";
export {
  resolveEnsembleConfigs,
  isEnsembleActive,
  providerKeyEnvVar,
  ALL_PROVIDER_NAMES,
  type EnsembleProviderSpec,
  type ResolveEnsembleParams,
  type ResolveEnsembleResult
} from "./ensemble.js";
export {
  withRetry,
  retrying,
  isRetryableError,
  backoffDelay,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  type RetryOptions
} from "./retry.js";
export {
  withFailback,
  modelFailbackChain,
  type FailbackEvent,
  type FailbackOptions
} from "./failback.js";

const PROVIDERS: Record<ProviderName, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider
};

/** Return whether a string is one of the supported provider names. */
function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

/** Look up a provider implementation by name. */
export function getProvider(name: ProviderName): Provider {
  return PROVIDERS[name];
}

/** Non-secret provider/model selection from the config file (#29). */
export interface ProviderDefaults {
  provider?: string;
  model?: string;
}

/**
 * Resolve provider configuration (BYOK). Selection precedence is
 * **env var > config default > built-in default**; blank env values are ignored.
 * Config model defaults are used only when the config provider is the selected
 * provider, so an out-of-band provider override cannot inherit another
 * provider's model name. The schema rejects model-only config; this resolver
 * also ignores model-only defaults defensively for direct callers.
 * The API key is always read from the environment and never from config:
 * - `PROWL_AI_PROVIDER` — optional `anthropic` | `openai` | `gemini`
 * - `PROWL_AI_KEY`      — generic provider API key fallback
 * - `PROWL_AI_KEY_<PROVIDER>` — provider-scoped key, preferred when set
 * - `PROWL_AI_MODEL`    — optional model override (per-provider default otherwise)
 *
 * `defaults` carries the `.prowl-review.yml` provider/model; `env` is injectable
 * for testing.
 */
export function resolveProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: ProviderDefaults = {}
): ProviderConfig {
  const envProvider = env.PROWL_AI_PROVIDER?.trim().toLowerCase();
  const defaultProvider = defaults.provider?.trim().toLowerCase();
  const raw = envProvider || defaultProvider || "anthropic";
  if (!isProviderName(raw)) {
    throw new Error(
      `Unsupported AI provider: ${raw}. Use one of: ${PROVIDER_NAMES.join(", ")}.`
    );
  }

  const providerKeyEnvVar = `PROWL_AI_KEY_${raw.toUpperCase()}`;
  const apiKey = env[providerKeyEnvVar]?.trim() || env.PROWL_AI_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      `PROWL_AI_KEY or ${providerKeyEnvVar} environment variable is required. Set it to your provider API key.`
    );
  }

  const configModelApplies = defaultProvider !== undefined && defaultProvider === raw;
  const configModel = configModelApplies ? defaults.model?.trim() : undefined;
  const model = env.PROWL_AI_MODEL?.trim() || configModel || DEFAULT_MODELS[raw];

  return protectProviderConfig({ provider: raw, model, apiKey });
}

/**
 * Run a completion against the configured (or supplied) provider. With no
 * `config`, resolves it from the environment via {@link resolveProviderConfig}.
 */
export async function complete(
  request: CompletionRequest,
  config: ProviderConfig = resolveProviderConfig()
): Promise<CompletionResult> {
  return getProvider(config.provider).complete(request, config);
}

/**
 * Run one tool-use turn against the configured (or supplied) provider. With no
 * `config`, resolves it from the environment via {@link resolveProviderConfig}.
 */
export async function completeWithTools(
  request: ToolCompletionRequest,
  config: ProviderConfig = resolveProviderConfig()
): Promise<ToolCompletionResult> {
  return getProvider(config.provider).completeWithTools(request, config);
}
