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
  const markdownChars = new Set(["\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", "!", "|", "~"]);
  let escaped = "";
  for (const char of sanitizeDisplayText(value)) {
    escaped += markdownChars.has(char) ? `\\${char}` : char;
  }
  return escaped;
}

/**
 * Built-in price table, keyed by model id. Exact matches win; dated snapshot
 * suffixes use the longest matching model-id prefix.
 * For providers with versioned model families, entries stay version-specific so
 * unknown future models return `n/a` until listed or overridden in config.
 * Estimates as of 2026; override in config if a rate is stale. USD per 1M tokens.
 */
export const DEFAULT_PRICES: Record<ProviderName, Record<string, ModelPrice>> = {
  anthropic: {
    "claude-fable-5": { input: 10, output: 50, cachedInput: 1 },
    "claude-mythos-5": { input: 10, output: 50, cachedInput: 1 },
    "claude-opus-4-8": { input: 5, output: 25, cachedInput: 0.5 },
    "claude-opus-4-7": { input: 5, output: 25, cachedInput: 0.5 },
    "claude-opus-4-6": { input: 5, output: 25, cachedInput: 0.5 },
    "claude-opus-4-5": { input: 5, output: 25, cachedInput: 0.5 },
    "claude-opus-4-1": { input: 15, output: 75, cachedInput: 1.5 },
    "claude-sonnet-4-6": { input: 3, output: 15, cachedInput: 0.3 },
    "claude-sonnet-4-5": { input: 3, output: 15, cachedInput: 0.3 },
    "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
    "claude-haiku-3-5": { input: 0.8, output: 4, cachedInput: 0.08 }
  },
  openai: {
    "gpt-5.5": { input: 5, output: 30, cachedInput: 0.5 },
    "gpt-5.4-mini": { input: 0.75, output: 4.5, cachedInput: 0.075 },
    "gpt-5.4": { input: 2.5, output: 15, cachedInput: 0.25 },
    "gpt-5.2": { input: 1.25, output: 10, cachedInput: 0.125 },
    "gpt-5-mini": { input: 0.25, output: 2, cachedInput: 0.025 },
    "gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 }
  },
  gemini: {
    "gemini-2.5-flash": { input: 0.3, output: 2.5, cachedInput: 0.03 }
    // Gemini 2.5 Pro has <=200K and >200K prompt-length tiers. Pipeline usage
    // is aggregated across calls, so built-in pricing returns n/a; configure an
    // exact override when the prompt tier is known.
  }
};

const UNSAFE_MODEL_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;

/** True when config overrides contain prototype-sensitive keys. */
function hasUnsafeOverrideKey(overrides: PriceOverrides): boolean {
  return Object.keys(overrides).some((key) => UNSAFE_MODEL_KEYS.has(key));
}

/** True when `model` is a dated snapshot of a known model id, e.g. `gpt-4o-2024-05-13`. */
function isDatedSnapshotMatch(model: string, key: string): boolean {
  if (!model.startsWith(`${key}-`)) {
    return false;
  }
  const firstSuffixCode = model.charCodeAt(key.length + 1);
  return firstSuffixCode >= 0x30 && firstSuffixCode <= 0x39;
}

/** A per-review cost estimate; `usd` is null when no price is known for the model. */
export interface CostEstimate {
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalTokens: number;
  /** Estimated USD, or null when the model has no known/overridden price. */
  usd: number | null;
}

/**
 * Resolve the price for `model`: an exact config override wins; otherwise an
 * exact built-in model id or dated snapshot prefix for the provider. Returns
 * null when unknown.
 */
export function resolveModelPrice(
  provider: ProviderName,
  model: string,
  overrides: PriceOverrides = {}
): ModelPrice | null {
  if (UNSAFE_MODEL_KEYS.has(model) || hasUnsafeOverrideKey(overrides)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, model)) {
    return overrides[model] ?? null;
  }
  const table = DEFAULT_PRICES[provider] ?? {};
  if (Object.prototype.hasOwnProperty.call(table, model)) {
    return table[model] ?? null;
  }
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(table)) {
    if (isDatedSnapshotMatch(model, key) && (!best || key.length > best.key.length)) {
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
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;
  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cachedInputTokens + cacheWriteInputTokens;
  let usd: number | null = null;
  if (price) {
    const cachedRate = price.cachedInput ?? price.input;
    const cacheWriteRate = provider === "anthropic" ? price.input * ANTHROPIC_CACHE_WRITE_MULTIPLIER : price.input;
    usd =
      (usage.inputTokens / 1_000_000) * price.input +
      (usage.outputTokens / 1_000_000) * price.output +
      (usage.cachedInputTokens / 1_000_000) * cachedRate +
      (cacheWriteInputTokens / 1_000_000) * cacheWriteRate;
  }
  return {
    provider,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens,
    totalTokens,
    usd
  };
}

/** Sum every token kind in a usage record (the unit the budget cap counts, #18). */
export function totalTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cachedInputTokens +
    (usage.cacheWriteInputTokens ?? 0)
  );
}

/** A per-PR spend ceiling (#18); set either or both. */
export interface Budget {
  /** Max total tokens (input+output+cached+cache-write) across the review. */
  maxTokens?: number;
  /** Max estimated USD; converted to a token ceiling via the model's input rate. */
  maxUsd?: number;
}

/**
 * Resolve a {@link Budget} into an effective max-token ceiling for mid-run
 * enforcement. `maxUsd` is converted to tokens via the model's **input** rate
 * (review spend is input-dominated) — an estimate, like all #36 figures — and
 * is dropped with a note when the model has no known price. With both set, the
 * tighter ceiling wins.
 */
export function resolveTokenBudget(
  budget: Budget | undefined,
  provider: ProviderName,
  model: string,
  overrides: PriceOverrides = {}
): { tokens: number | null; notes: string[] } {
  if (!budget) {
    return { tokens: null, notes: [] };
  }
  const ceilings: number[] = [];
  const notes: string[] = [];
  if (typeof budget.maxTokens === "number") {
    ceilings.push(budget.maxTokens);
  }
  if (typeof budget.maxUsd === "number") {
    const price = resolveModelPrice(provider, model, overrides);
    if (price && price.input > 0) {
      ceilings.push(Math.floor((budget.maxUsd / price.input) * 1_000_000));
    } else {
      notes.push(
        `Budget maxUsd ignored: no known price for ${provider}/${model} — set pricing in config or use maxTokens.`
      );
    }
  }
  return { tokens: ceilings.length > 0 ? Math.min(...ceilings) : null, notes };
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
  const cacheWrite =
    estimate.cacheWriteInputTokens > 0 ? ` / cache write ${estimate.cacheWriteInputTokens.toLocaleString()}` : "";
  const tokens =
    `in ${estimate.inputTokens.toLocaleString()} / out ${estimate.outputTokens.toLocaleString()} / ` +
    `cached ${estimate.cachedInputTokens.toLocaleString()}${cacheWrite} tok`;
  const safeModel = sanitizeDisplayText(estimate.model).replace(/[^a-zA-Z0-9._:-]/g, "");
  const model = escapeMarkdownDisplayText(safeModel);
  return `${cost} · ${estimate.provider}/${model} · ${tokens} [estimated]`;
}
