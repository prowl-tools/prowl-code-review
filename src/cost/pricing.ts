import type { ProviderName, TokenUsage } from "../providers/index.js";

/**
 * Token pricing + cost estimation (backlog #36).
 *
 * BYOK means the user pays the provider directly; this module exists only to
 * give them per-review *transparency* (confirm it's pennies), never to be a
 * billing system — the provider dashboard is the source of truth. Every figure
 * is an **estimate**: prices are USD per 1M tokens, shipped as a built-in table
 * that BYOK users can override in `.prowl-review.yml` (`pricing:`) when a
 * provider changes rates or a model isn't listed.
 */

/** USD per 1,000,000 tokens for one model. */
export interface ModelPrice {
  /** Uncached input tokens. */
  input: number;
  /** Generated output tokens. */
  output: number;
  /** Cached (read) input tokens; defaults to `input` when omitted. */
  cachedInput?: number;
}

/** Per-model overrides keyed by exact model id (from `.prowl-review.yml`). */
export type PriceOverrides = Record<string, ModelPrice>;

/** Return the last index of a recognized ANSI escape sequence, or `start` when malformed. */
function ansiSequenceEnd(value: string, start: number): number {
  const next = value.charCodeAt(start + 1);
  if (next === 0x5B) {
    for (let index = start + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7E) {
        return index;
      }
    }
    return start;
  }
  if (next >= 0x40 && next <= 0x5F) {
    return start + 1;
  }
  return start;
}

/** Strip terminal/HTML-sensitive characters from untrusted display text. */
export function sanitizeDisplayText(value: string): string {
  let sanitized = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const char = value[index];
    if (code === 0x1B) {
      index = ansiSequenceEnd(value, index);
      continue;
    }
    if (code < 0x20 || code === 0x7F) {
      sanitized += " ";
      continue;
    }
    if (char === "<" || char === ">") {
      continue;
    }
    sanitized += char;
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

/** Escape sanitized display text for inline Markdown and table cells. */
export function escapeMarkdownDisplayText(value: string): string {
  const markdownChars = new Set(["\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", "!", "|"]);
  let escaped = "";
  for (const char of sanitizeDisplayText(value)) {
    escaped += markdownChars.has(char) ? `\\${char}` : char;
  }
  return escaped;
}

/**
 * Built-in price table, keyed by a model-id **prefix** (longest match wins), so
 * `claude-sonnet-4-6` resolves via the `claude-sonnet` entry. Estimates as of
 * 2026; override in config if a rate is stale. USD per 1M tokens.
 */
export const DEFAULT_PRICES: Record<ProviderName, Record<string, ModelPrice>> = {
  anthropic: {
    "claude-opus": { input: 15, output: 75, cachedInput: 1.5 },
    "claude-sonnet": { input: 3, output: 15, cachedInput: 0.3 },
    "claude-haiku": { input: 0.8, output: 4, cachedInput: 0.08 }
  },
  openai: {
    "gpt-5-mini": { input: 0.25, output: 2, cachedInput: 0.025 },
    "gpt-5": { input: 1.25, output: 10, cachedInput: 0.125 },
    "gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 }
  },
  gemini: {
    "gemini-2.5-flash": { input: 0.3, output: 2.5, cachedInput: 0.075 },
    "gemini-2.5-pro": { input: 1.25, output: 10, cachedInput: 0.31 }
  }
};

/** A per-review cost estimate; `usd` is null when no price is known for the model. */
export interface CostEstimate {
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  /** Estimated USD, or null when the model has no known/overridden price. */
  usd: number | null;
}

/**
 * Resolve the price for `model`: an exact config override wins; otherwise the
 * longest matching built-in prefix for the provider. Returns null when unknown.
 */
export function resolveModelPrice(
  provider: ProviderName,
  model: string,
  overrides: PriceOverrides = {}
): ModelPrice | null {
  if (Object.prototype.hasOwnProperty.call(overrides, model)) {
    return overrides[model] ?? null;
  }
  const table = DEFAULT_PRICES[provider] ?? {};
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(table)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best?.price ?? null;
}

/** Estimate the USD cost of `usage` for a provider/model (null `usd` when unpriced). */
export function estimateCost(
  usage: TokenUsage,
  provider: ProviderName,
  model: string,
  overrides: PriceOverrides = {}
): CostEstimate {
  const price = resolveModelPrice(provider, model, overrides);
  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cachedInputTokens;
  let usd: number | null = null;
  if (price) {
    const cachedRate = price.cachedInput ?? price.input;
    usd =
      (usage.inputTokens / 1_000_000) * price.input +
      (usage.outputTokens / 1_000_000) * price.output +
      (usage.cachedInputTokens / 1_000_000) * cachedRate;
  }
  return {
    provider,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    totalTokens,
    usd
  };
}

/** Format a USD amount for display (more precision for sub-dollar amounts). */
export function formatUsd(usd: number | null): string {
  if (usd === null) {
    return "n/a";
  }
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Compact one-line cost summary, e.g. `~$0.0123 · anthropic/claude-… · in 12,345 / out 2,345 / cached 1,000 tok [estimated]`. */
export function formatCostLine(estimate: CostEstimate): string {
  const cost = estimate.usd === null ? "n/a (set pricing in config)" : `~${formatUsd(estimate.usd)}`;
  const tokens =
    `in ${estimate.inputTokens.toLocaleString()} / out ${estimate.outputTokens.toLocaleString()} / ` +
    `cached ${estimate.cachedInputTokens.toLocaleString()} tok`;
  return `${cost} · ${estimate.provider}/${escapeMarkdownDisplayText(estimate.model)} · ${tokens} [estimated]`;
}
