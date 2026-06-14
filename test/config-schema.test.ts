import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";

describe("configSchema (#29)", () => {
  it("accepts an empty config (everything is optional)", () => {
    expect(configSchema.parse({})).toEqual({});
  });

  it("accepts a fully-specified config", () => {
    const input = {
      provider: "openai",
      model: "gpt-x",
      agentPrompt: false,
      review: { minSeverity: "major", minConfidence: 0.7, maxFindings: 10, maxInlineComments: 15, verify: false, verifyConfidence: 0.9 },
      context: { enabled: false, maxRounds: 3, maxFiles: 8 },
      grounding: { enabled: true },
      diff: { maxFiles: 50, maxBytes: 100000 }
    };
    expect(configSchema.parse(input)).toEqual(input);
  });

  it("accepts the agentPrompt toggle and rejects a non-boolean (#57)", () => {
    expect(configSchema.parse({ agentPrompt: true })).toEqual({ agentPrompt: true });
    expect(() => configSchema.parse({ agentPrompt: "yes" })).toThrow();
  });

  it("accepts a budget cap and rejects malformed values (#18)", () => {
    expect(configSchema.parse({ budget: { maxTokens: 200000 } })).toEqual({ budget: { maxTokens: 200000 } });
    expect(configSchema.parse({ budget: { maxUsd: 0.5 } })).toEqual({ budget: { maxUsd: 0.5 } });
    expect(configSchema.parse({ budget: { maxTokens: 100, maxUsd: 1 } })).toEqual({ budget: { maxTokens: 100, maxUsd: 1 } });
    expect(() => configSchema.parse({ budget: { maxTokens: 0 } })).toThrow(); // positive
    expect(() => configSchema.parse({ budget: { maxUsd: -1 } })).toThrow();
    expect(() => configSchema.parse({ budget: { nope: 1 } })).toThrow(); // strict
  });

  it("accepts a pricing override map and rejects malformed entries (#36)", () => {
    const pricing = { "claude-sonnet-4-6": { input: 3, output: 15, cachedInput: 0.3 } };
    expect(configSchema.parse({ pricing })).toEqual({ pricing });
    expect(configSchema.parse({ pricing: { m: { input: 1, output: 2 } } })).toEqual({ pricing: { m: { input: 1, output: 2 } } });
    expect(() => configSchema.parse({ pricing: { m: { input: 1 } } })).toThrow(); // output required
    expect(() => configSchema.parse({ pricing: { m: { input: -1, output: 2 } } })).toThrow(); // negative
  });

  it("accepts maxInlineComments incl. 0 and rejects negative/non-int (#25)", () => {
    expect(configSchema.parse({ review: { maxInlineComments: 0 } })).toEqual({ review: { maxInlineComments: 0 } });
    expect(() => configSchema.parse({ review: { maxInlineComments: -1 } })).toThrow();
    expect(() => configSchema.parse({ review: { maxInlineComments: 2.5 } })).toThrow();
  });

  it("accepts an ignore glob list (incl. empty) and rejects non-string entries (#19)", () => {
    expect(configSchema.parse({ ignore: ["node_modules", "*.snap"] })).toEqual({ ignore: ["node_modules", "*.snap"] });
    expect(configSchema.parse({ ignore: [] })).toEqual({ ignore: [] });
    expect(() => configSchema.parse({ ignore: [""] })).toThrow();
    expect(() => configSchema.parse({ ignore: "node_modules" })).toThrow();
  });

  it("rejects an unknown top-level key (strict — catches typos)", () => {
    expect(() => configSchema.parse({ revieww: {} })).toThrow();
  });

  it("rejects an unknown nested key", () => {
    expect(() => configSchema.parse({ review: { minSeverty: "major" } })).toThrow();
  });

  it("rejects an invalid severity", () => {
    expect(() => configSchema.parse({ review: { minSeverity: "urgent" } })).toThrow();
  });

  it("rejects an unknown provider", () => {
    expect(() => configSchema.parse({ provider: "llama" })).toThrow();
  });

  it("rejects model without provider so model names stay provider-scoped", () => {
    expect(() => configSchema.parse({ model: "gpt-custom" })).toThrow(/model requires provider/);
  });

  it("rejects workspace trust from repo config", () => {
    expect(() => configSchema.parse({ grounding: { trustWorkspace: true } })).toThrow();
  });

  it("rejects confidence outside 0–1", () => {
    expect(() => configSchema.parse({ review: { minConfidence: 1.5 } })).toThrow();
    expect(() => configSchema.parse({ review: { verifyConfidence: -0.1 } })).toThrow();
  });

  it("rejects non-positive limits", () => {
    expect(() => configSchema.parse({ review: { maxFindings: 0 } })).toThrow();
    expect(() => configSchema.parse({ context: { maxFiles: -1 } })).toThrow();
    expect(() => configSchema.parse({ diff: { maxBytes: 0 } })).toThrow();
  });
});
