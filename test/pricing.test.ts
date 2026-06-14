import { describe, expect, it } from "vitest";
import { resolveModelPrice, estimateCost, formatUsd, formatCostLine, sanitizeDisplayText } from "../src/cost/pricing.js";
import type { TokenUsage } from "../src/providers/index.js";

const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 1_000_000 };

describe("resolveModelPrice", () => {
  it("matches a model by built-in prefix", () => {
    expect(resolveModelPrice("anthropic", "claude-sonnet-4-6")).toEqual({ input: 3, output: 15, cachedInput: 0.3 });
    expect(resolveModelPrice("anthropic", "claude-opus-4-8")).toEqual({ input: 5, output: 25, cachedInput: 0.5 });
    expect(resolveModelPrice("anthropic", "claude-haiku-4-5-20251001")).toEqual({ input: 1, output: 5, cachedInput: 0.1 });
    expect(resolveModelPrice("openai", "gpt-5.2")).toEqual({ input: 1.25, output: 10, cachedInput: 0.125 });
    expect(resolveModelPrice("openai", "gpt-5.4-mini")).toEqual({ input: 0.75, output: 4.5, cachedInput: 0.075 });
  });

  it("prefers the longest matching prefix", () => {
    // "gpt-5.4-mini" must win over "gpt-5.4" for a dated mini snapshot.
    expect(resolveModelPrice("openai", "gpt-5.4-mini-2026")).toEqual({ input: 0.75, output: 4.5, cachedInput: 0.075 });
  });

  it("lets an exact config override win over the table", () => {
    const override = { "claude-sonnet-4-6": { input: 99, output: 199 } };
    expect(resolveModelPrice("anthropic", "claude-sonnet-4-6", override)).toEqual({ input: 99, output: 199 });
  });

  it("ignores inherited override properties", () => {
    const overrides = Object.create({
      "claude-sonnet-4-6": { input: 99, output: 199 }
    }) as Record<string, { input: number; output: number }>;
    expect(resolveModelPrice("anthropic", "claude-sonnet-4-6", overrides)).toEqual({ input: 3, output: 15, cachedInput: 0.3 });
  });

  it("returns null for an unknown model", () => {
    expect(resolveModelPrice("anthropic", "mystery-model")).toBeNull();
    expect(resolveModelPrice("anthropic", "claude-opus-4-9")).toBeNull();
    expect(resolveModelPrice("openai", "gpt-5.4-nano")).toBeNull();
  });
});

describe("estimateCost", () => {
  it("computes USD from per-1M rates incl. the cached rate", () => {
    const cost = estimateCost(usage, "anthropic", "claude-sonnet-4-6");
    // 1M input*$3 + 1M output*$15 + 1M cached*$0.3 = 18.3
    expect(cost.usd).toBeCloseTo(18.3, 5);
    expect(cost.totalTokens).toBe(3_000_000);
  });

  it("falls back to the input rate when no cached rate is set", () => {
    const cost = estimateCost(
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 },
      "anthropic",
      "x",
      { x: { input: 4, output: 8 } }
    );
    expect(cost.usd).toBeCloseTo(4, 5); // cached billed at input rate
  });

  it("returns null usd for an unpriced model (never guesses)", () => {
    const cost = estimateCost(usage, "anthropic", "mystery-model");
    expect(cost.usd).toBeNull();
    expect(cost.totalTokens).toBe(3_000_000);
  });
});

describe("formatUsd / formatCostLine", () => {
  it("uses more precision for sub-dollar amounts", () => {
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(null)).toBe("n/a");
  });

  it("renders a compact estimated cost line", () => {
    const line = formatCostLine(estimateCost(usage, "anthropic", "claude-sonnet-4-6"));
    expect(line).toContain("~$18.30");
    expect(line).toContain("anthropic/claude-sonnet-4-6");
    expect(line).toContain("[estimated]");
  });

  it("flags an unpriced model in the cost line", () => {
    const line = formatCostLine(estimateCost(usage, "anthropic", "mystery-model"));
    expect(line).toContain("set pricing in config");
  });

  it("sanitizes model names for human-readable output", () => {
    expect(sanitizeDisplayText("gpt\u001b[31m-red\u001b[0m<script>")).toBe("gpt-redscript");
    expect(sanitizeDisplayText("\u001b[31")).toBe("[31");
    const line = formatCostLine({
      ...estimateCost(usage, "openai", "gpt-5"),
      model: "gpt\u001b[31m-red\u001b[0m<script>"
    });
    expect(line).toContain("openai/gpt-redscript");
    expect(line).not.toContain("\u001b[31m");
    expect(line).not.toContain("<script>");
  });

  it("escapes markdown table metacharacters in model names", () => {
    const line = formatCostLine({
      ...estimateCost(usage, "openai", "gpt-5"),
      model: "gpt|spoof"
    });
    expect(line).toContain("openai/gpt\\|spoof");
  });

  it("removes line breaks from model names in cost lines", () => {
    const line = formatCostLine({
      ...estimateCost(usage, "openai", "gpt-5"),
      model: "gpt\nspoof\rline"
    });
    expect(line).toContain("openai/gpt spoof line");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
  });
});
