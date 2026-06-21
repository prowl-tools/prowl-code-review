import { DEFAULT_MODELS, PROVIDER_NAMES, type ProviderConfig, type ProviderName } from "./types.js";

/**
 * Per-provider key resolution for the multi-provider ensemble (#53).
 *
 * BYOK stays BYOK: every provider's key is read from the environment, never from
 * repo config. Each ensemble provider reads `PROWL_AI_KEY_<PROVIDER>` (e.g.
 * `PROWL_AI_KEY_OPENAI`); the provider that matches the already-resolved primary
 * also falls back to the plain `PROWL_AI_KEY`, so a single-key setup keeps
 * working. A provider with no key is skipped with a note (never silently
 * dropped, #5). With fewer than two usable providers the caller runs a normal
 * single-provider review.
 */

/** One provider entry from `.prowl-review.yml`'s `ensemble.providers`. */
export interface EnsembleProviderSpec {
  provider: ProviderName;
  model?: string;
}

/** Inputs for resolving the ensemble's per-provider configs. */
export interface ResolveEnsembleParams {
  /** The primary provider config (already resolved with `PROWL_AI_KEY`). */
  primary: ProviderConfig;
  /** Configured providers; when empty/omitted the ensemble is just the primary. */
  providers?: EnsembleProviderSpec[];
  /** Environment (injectable for tests). */
  env?: NodeJS.ProcessEnv;
}

export interface ResolveEnsembleResult {
  /** One config per usable provider (deduped, key present). */
  configs: ProviderConfig[];
  /** Operational notes (skipped providers, dedupes) — surfaced, never silent. */
  notes: string[];
}

/** Env var holding a provider's API key, e.g. `PROWL_AI_KEY_ANTHROPIC`. */
export function providerKeyEnvVar(provider: ProviderName): string {
  return `PROWL_AI_KEY_${provider.toUpperCase()}`;
}

/** Resolve a usable {@link ProviderConfig} per configured provider (#53). */
export function resolveEnsembleConfigs(params: ResolveEnsembleParams): ResolveEnsembleResult {
  const env = params.env ?? process.env;
  const specs =
    params.providers && params.providers.length > 0
      ? params.providers
      : [{ provider: params.primary.provider, model: params.primary.model }];
  const notes: string[] = [];
  const configs: ProviderConfig[] = [];
  const seen = new Set<ProviderName>();

  for (const spec of specs) {
    if (seen.has(spec.provider)) {
      notes.push(`Ensemble: ignored duplicate provider "${spec.provider}".`);
      continue;
    }
    seen.add(spec.provider);

    const envVar = providerKeyEnvVar(spec.provider);
    const isPrimary = spec.provider === params.primary.provider;
    const apiKey = env[envVar]?.trim() || (isPrimary ? params.primary.apiKey : undefined);
    if (!apiKey) {
      notes.push(`Ensemble: skipped "${spec.provider}" — no ${envVar} set.`);
      continue;
    }

    const model = spec.model?.trim() || (isPrimary ? params.primary.model : DEFAULT_MODELS[spec.provider]);
    configs.push({ provider: spec.provider, model, apiKey });
  }

  return { configs, notes };
}

/** True when the resolved ensemble has enough usable providers to run (#53). */
export function isEnsembleActive(configs: ProviderConfig[]): boolean {
  return configs.length >= 2;
}

/** All provider names, exposed for callers building default ensemble lists. */
export const ALL_PROVIDER_NAMES = PROVIDER_NAMES;
