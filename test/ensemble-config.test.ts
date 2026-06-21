import { describe, expect, it } from "vitest";
import {
  resolveEnsembleConfigs,
  isEnsembleActive,
  providerKeyEnvVar
} from "../src/providers/ensemble.js";
import type { ProviderConfig } from "../src/providers/types.js";

const primary: ProviderConfig = { provider: "anthropic", model: "claude-x", apiKey: "anthropic-key" };

describe("providerKeyEnvVar", () => {
  it("maps a provider to its per-provider key env var", () => {
    expect(providerKeyEnvVar("anthropic")).toBe("PROWL_AI_KEY_ANTHROPIC");
    expect(providerKeyEnvVar("openai")).toBe("PROWL_AI_KEY_OPENAI");
    expect(providerKeyEnvVar("gemini")).toBe("PROWL_AI_KEY_GEMINI");
  });
});

describe("resolveEnsembleConfigs (#53)", () => {
  it("defaults omitted providers to the primary provider", () => {
    const { configs, notes } = resolveEnsembleConfigs({ primary, env: {} as NodeJS.ProcessEnv });

    expect(configs).toEqual([primary]);
    expect(notes).toEqual([]);
  });

  it("defaults an empty provider list to the primary provider", () => {
    const { configs, notes } = resolveEnsembleConfigs({
      primary,
      providers: [],
      env: {} as NodeJS.ProcessEnv
    });

    expect(configs).toEqual([primary]);
    expect(notes).toEqual([]);
  });

  it("resolves each provider's key from its env var", () => {
    const { configs, notes } = resolveEnsembleConfigs({
      primary,
      providers: [{ provider: "anthropic" }, { provider: "openai" }, { provider: "gemini" }],
      env: { PROWL_AI_KEY_OPENAI: "openai-key", PROWL_AI_KEY_GEMINI: "gemini-key" } as NodeJS.ProcessEnv
    });
    expect(configs.map((c) => c.provider)).toEqual(["anthropic", "openai", "gemini"]);
    expect(configs.find((c) => c.provider === "openai")?.apiKey).toBe("openai-key");
    expect(notes).toEqual([]);
  });

  it("falls back to PROWL_AI_KEY for the primary provider only", () => {
    const { configs } = resolveEnsembleConfigs({
      primary,
      providers: [{ provider: "anthropic" }, { provider: "openai" }],
      env: { PROWL_AI_KEY_OPENAI: "openai-key" } as NodeJS.ProcessEnv
    });
    // anthropic uses the primary's key; openai uses its own.
    expect(configs.find((c) => c.provider === "anthropic")?.apiKey).toBe("anthropic-key");
    expect(configs.find((c) => c.provider === "openai")?.apiKey).toBe("openai-key");
  });

  it("skips a provider with no key and notes it (no silent drop)", () => {
    const { configs, notes } = resolveEnsembleConfigs({
      primary,
      providers: [{ provider: "anthropic" }, { provider: "openai" }],
      env: {} as NodeJS.ProcessEnv
    });
    expect(configs.map((c) => c.provider)).toEqual(["anthropic"]);
    expect(notes.join(" ")).toContain('skipped "openai" — no PROWL_AI_KEY_OPENAI');
  });

  it("applies a per-provider model override and defaults others", () => {
    const { configs } = resolveEnsembleConfigs({
      primary,
      providers: [{ provider: "anthropic" }, { provider: "openai", model: "gpt-custom" }],
      env: { PROWL_AI_KEY_OPENAI: "k" } as NodeJS.ProcessEnv
    });
    expect(configs.find((c) => c.provider === "anthropic")?.model).toBe("claude-x"); // primary's model
    expect(configs.find((c) => c.provider === "openai")?.model).toBe("gpt-custom");
  });

  it("dedupes a repeated provider with a note", () => {
    const { configs, notes } = resolveEnsembleConfigs({
      primary,
      providers: [{ provider: "anthropic" }, { provider: "anthropic" }],
      env: {} as NodeJS.ProcessEnv
    });
    expect(configs).toHaveLength(1);
    expect(notes.join(" ")).toContain("duplicate provider");
  });
});

describe("isEnsembleActive", () => {
  it("requires at least two usable providers", () => {
    expect(isEnsembleActive([primary])).toBe(false);
    expect(isEnsembleActive([primary, { ...primary, provider: "openai" }])).toBe(true);
  });
});
