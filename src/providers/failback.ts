import { isRetryableError } from "./retry.js";
import { codexErrorKind } from "./codex.js";
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
  gemini: [["gemini-2.5-pro", "gemini-2.5-flash"]],
  // Codex draws from the ChatGPT plan; `gpt-5.4`/`gpt-5.4-mini` leave ChatGPT
  // sign-in 2026-08-31, so they are not on this ladder (#45).
  codex: [["gpt-5.6-terra", "gpt-5.5"]]
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

/**
 * Live models to try when the configured model is *rejected as unavailable* under
 * a provider (a retired Codex model like `gpt-5.4` after 2026-08-31, #65) — as
 * opposed to overload failback, which only steps to older same-family models.
 * Because the configured model may not be on any ladder, this returns the whole
 * provider ladder's live targets, newest → oldest; empty for providers without one.
 */
export function retiredModelFallbacks(provider: ProviderName): string[] {
  return (FAILBACK_LADDERS[provider] ?? []).flat();
}

/** Why a failback happened: sustained provider overload, or a retired/unavailable model (#65). */
export type FailbackReason = "overload" | "model-retired";

/** A failback event: a provider successfully completed with a fallback model. */
export interface FailbackEvent {
  provider: ProviderName;
  from: string;
  to: string;
  error: unknown;
  /** Why the failback happened (default "overload"). */
  reason: FailbackReason;
}

export interface FailbackOptions {
  /** Resolve the overload fallback model chain (defaults to {@link modelFailbackChain}). */
  chain?: (provider: ProviderName, model: string) => string[];
  /** Resolve the retired-model fallback list (defaults to {@link retiredModelFallbacks}). */
  retiredChain?: (provider: ProviderName) => string[];
  /** Notified after a failback target successfully completes (for review notes/logs). */
  onFailback?: (event: FailbackEvent) => void;
}

/**
 * Wrap a (already retry-wrapped) completion so that, on a *sustained* failure, it
 * retries with a fallback model. Two triggers, both shape-preserving so this drops
 * into the injectable `complete` slot:
 * - **overload** — a retryable failure that survived retries steps to the next
 *   older same-family model ({@link modelFailbackChain}).
 * - **model-retired** (#65) — a Codex model rejected as unavailable under ChatGPT
 *   sign-in falls through to the provider's live ladder ({@link retiredModelFallbacks}),
 *   even when the configured (retired) model was on no ladder.
 * Each model gets the wrapped function's full retry budget before failback. Any
 * other error (bad request / auth / usage-limit) fails fast without a fallback.
 */
export function withFailback<Req, Res>(
  complete: (request: Req, config: ProviderConfig) => Promise<Res>,
  options: FailbackOptions = {}
): (request: Req, config: ProviderConfig) => Promise<Res> {
  const chain = options.chain ?? modelFailbackChain;
  const retiredChain = options.retiredChain ?? retiredModelFallbacks;
  return async (request, config) => {
    const from = config.model;
    const tried = new Set<string>([config.model]);
    let currentModel = config.model;
    let pendingFailback: FailbackEvent | undefined;
    for (;;) {
      try {
        const result = await complete(
          request,
          protectProviderConfig({ provider: config.provider, model: currentModel, apiKey: config.apiKey })
        );
        if (pendingFailback) {
          options.onFailback?.(pendingFailback);
        }
        return result;
      } catch (error) {
        const retired = codexErrorKind(error) === "model-retired";
        const overload = isRetryableError(error);
        if (!retired && !overload) {
          throw error;
        }
        // Overload steps down the same family; a retired model may also draw on the
        // provider's live ladder so a model on no rung still has somewhere to go.
        const candidates = retired
          ? [...chain(config.provider, currentModel), ...retiredChain(config.provider)]
          : chain(config.provider, currentModel);
        const next = candidates.find((model) => !tried.has(model));
        if (next === undefined) {
          throw error;
        }
        tried.add(next);
        pendingFailback = {
          provider: config.provider,
          from,
          to: next,
          error,
          reason: retired ? "model-retired" : "overload"
        };
        currentModel = next;
      }
    }
  };
}
