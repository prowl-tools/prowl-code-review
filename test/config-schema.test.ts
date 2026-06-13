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
      review: { minSeverity: "major", minConfidence: 0.7, maxFindings: 10, verify: false, verifyConfidence: 0.9 },
      context: { enabled: false, maxRounds: 3, maxFiles: 8 },
      grounding: { enabled: true },
      diff: { maxFiles: 50, maxBytes: 100000 }
    };
    expect(configSchema.parse(input)).toEqual(input);
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
