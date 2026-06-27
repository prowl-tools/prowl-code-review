import { isRetryableError } from "./retry.js";
import { protectProviderConfig, type ProviderConfig, type ProviderName } from "./types.js";

/**
 * Cross-generation failback (backlog #17).
 *
 * Retry/backoff (see `retry.ts`) handles transient blips. Failback handles
 * *sustained* trouble: when a provider keeps returning retryable/overload errors
 * (429/503/5xx) even after retries are exhausted, fall back to an **older model
 * of the same family + provider** — a degraded-but-real review beats a failed
 * pass. It never crosses providers (that's the ensemble's job, #53) and never
 * falls back on a non-retryable error (bad request/auth fail fast).
 *
 * Ladders are best-effort and include only known live targets: a model not on a
 * ladder simply has no fallback (the call fails as before). BYOK users on a
 * pinned custom model just won't fail back, which is the safe default.
 */

/** Per-provider model ladders, newest → oldest within each family. */
const FAILBACK_LADDERS: Record<ProviderName, string[][]> = {
  anthropic: [
    ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-opus-4-1"],
    ["claude-sonnet-4-6", "claude-sonnet-4-5"]
  ],
  openai: [
    ["gpt-5.5", "gpt-5.4", "gpt-5.2"],
    ["gpt-5.4-mini", "gpt-5-mini"]
  ],
  gemini: [["gemini-2.5-pro", "gemini-2.5-flash"]]
};

/**
 * Older same-family models to fall back to, in order, after `model` — or [] when
 * the model isn't on a known ladder (no failback).
 */
export function modelFailbackChain(provider: ProviderName, model: string): string[] {
  const ladder = (FAILBACK_LADDERS[provider] ?? []).find((rung) => rung.includes(model));
  if (!ladder) {
    return [];
  }
  return ladder.slice(ladder.indexOf(model) + 1);
}

/** A failback event: a provider successfully completed with an older model. */
export interface FailbackEvent {
  provider: ProviderName;
  from: string;
  to: string;
  error: unknown;
}

export interface FailbackOptions {
  /** Resolve the fallback model chain (defaults to {@link modelFailbackChain}). */
  chain?: (provider: ProviderName, model: string) => string[];
  /** Notified after a failback target successfully completes (for review notes/logs). */
  onFailback?: (event: FailbackEvent) => void;
}

/**
 * Wrap a (already retry-wrapped) completion so that, on a retryable failure that
 * survived retries, it retries with the next older model in the family. Each
 * model gets the wrapped function's full retry budget before failback. Shape-
 * preserving, so it drops into the injectable `complete` slot.
 */
export function withFailback<Req, Res>(
  complete: (request: Req, config: ProviderConfig) => Promise<Res>,
  options: FailbackOptions = {}
): (request: Req, config: ProviderConfig) => Promise<Res> {
  const chain = options.chain ?? modelFailbackChain;
  return async (request, config) => {
    const models = [config.model, ...chain(config.provider, config.model)];
    let lastError: unknown;
    let pendingFailback: FailbackEvent | undefined;
    for (let index = 0; index < models.length; index += 1) {
      try {
        const result = await complete(
          request,
          protectProviderConfig({ provider: config.provider, model: models[index], apiKey: config.apiKey })
        );
        if (pendingFailback) {
          options.onFailback?.(pendingFailback);
        }
        return result;
      } catch (error) {
        lastError = error;
        const hasOlder = index < models.length - 1;
        if (!hasOlder || !isRetryableError(error)) {
          throw error;
        }
        pendingFailback = {
          provider: config.provider,
          from: pendingFailback?.from ?? models[index],
          to: models[index + 1],
          error
        };
      }
    }
    throw lastError ?? new Error("withFailback exhausted without an error");
  };
}
