import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import { geminiProvider } from "./gemini.js";
import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderConfig,
  type ProviderName,
  DEFAULT_MODELS,
  PROVIDER_NAMES
} from "./types.js";

export * from "./types.js";

const PROVIDERS: Record<ProviderName, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider
};

function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

/** Look up a provider implementation by name. */
export function getProvider(name: ProviderName): Provider {
  return PROVIDERS[name];
}

/**
 * Resolve provider configuration from the environment (BYOK):
 * - `PROWL_AI_PROVIDER` — `anthropic` (default) | `openai` | `gemini`
 * - `PROWL_AI_KEY`      — the provider API key (required)
 * - `PROWL_AI_MODEL`    — optional model override (per-provider default otherwise)
 *
 * `env` is injectable for testing.
 */
export function resolveProviderConfig(
  env: NodeJS.ProcessEnv = process.env
): ProviderConfig {
  const raw = (env.PROWL_AI_PROVIDER ?? "anthropic").toLowerCase();
  if (!isProviderName(raw)) {
    throw new Error(
      `Unsupported AI provider: ${raw}. Use one of: ${PROVIDER_NAMES.join(", ")}.`
    );
  }

  const apiKey = env.PROWL_AI_KEY;
  if (!apiKey) {
    throw new Error(
      "PROWL_AI_KEY environment variable is required. Set it to your provider API key."
    );
  }

  const model = env.PROWL_AI_MODEL ?? DEFAULT_MODELS[raw];

  return { provider: raw, model, apiKey };
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
