import { afterEach, describe, expect, it, vi } from "vitest";
import {
  complete,
  resolveProviderConfig,
  DEFAULT_MODELS,
  type ProviderConfig
} from "../src/providers/index.js";

type Json = Record<string, unknown>;

/** Build a mock `fetch` returning the given JSON payload. */
function mockFetch(payload: Json, ok = true, status = 200) {
  const fn = vi.fn(async () => ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Parse the JSON body passed to the mocked fetch's first call. */
function bodyOf(fn: ReturnType<typeof vi.fn>): Json {
  const init = fn.mock.calls[0][1] as { body: string };
  return JSON.parse(init.body) as Json;
}

function urlOf(fn: ReturnType<typeof vi.fn>): string {
  return fn.mock.calls[0][0] as string;
}

function headersOf(fn: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fn.mock.calls[0][1] as { headers: Record<string, string> };
  return init.headers;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveProviderConfig", () => {
  it("defaults to anthropic with the default model", () => {
    const cfg = resolveProviderConfig({ PROWL_AI_KEY: "k" } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({
      provider: "anthropic",
      model: DEFAULT_MODELS.anthropic,
      apiKey: "k"
    });
  });

  it("throws when the API key is missing", () => {
    expect(() => resolveProviderConfig({} as NodeJS.ProcessEnv)).toThrow(/PROWL_AI_KEY/);
  });

  it("throws on an unsupported provider", () => {
    expect(() =>
      resolveProviderConfig({
        PROWL_AI_PROVIDER: "cohere",
        PROWL_AI_KEY: "k"
      } as NodeJS.ProcessEnv)
    ).toThrow(/Unsupported AI provider/);
  });

  it("honors provider (case-insensitive) and model overrides", () => {
    const cfg = resolveProviderConfig({
      PROWL_AI_PROVIDER: "OpenAI",
      PROWL_AI_KEY: "k",
      PROWL_AI_MODEL: "custom-model"
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ provider: "openai", model: "custom-model", apiKey: "k" });
  });

  it("uses the per-provider default model", () => {
    const cfg = resolveProviderConfig({
      PROWL_AI_PROVIDER: "gemini",
      PROWL_AI_KEY: "k"
    } as NodeJS.ProcessEnv);
    expect(cfg.model).toBe(DEFAULT_MODELS.gemini);
  });
});

describe("anthropic provider", () => {
  const config: ProviderConfig = { provider: "anthropic", model: "claude-x", apiKey: "key" };

  it("caches the system block and maps usage", async () => {
    const fn = mockFetch({
      content: [{ type: "text", text: "review" }],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 }
    });

    const result = await complete({ system: "guidelines", prompt: "diff" }, config);

    expect(urlOf(fn)).toBe("https://api.anthropic.com/v1/messages");
    expect(headersOf(fn)["x-api-key"]).toBe("key");
    const body = bodyOf(fn);
    expect(body.system).toEqual([
      { type: "text", text: "guidelines", cache_control: { type: "ephemeral" } }
    ]);
    expect(body.messages).toEqual([{ role: "user", content: "diff" }]);
    expect(result.text).toBe("review");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 900
    });
  });

  it("omits the system field when no system content is given", async () => {
    const fn = mockFetch({ content: [{ type: "text", text: "ok" }] });
    await complete({ prompt: "diff" }, config);
    expect(bodyOf(fn).system).toBeUndefined();
  });

  it("throws on a non-ok response", async () => {
    mockFetch({ error: "bad" }, false, 429);
    await expect(complete({ prompt: "diff" }, config)).rejects.toThrow(/Anthropic API error \(429\)/);
  });
});

describe("openai provider", () => {
  const config: ProviderConfig = { provider: "openai", model: "gpt-x", apiKey: "key" };

  it("sends system + user messages and maps cached usage", async () => {
    const fn = mockFetch({
      choices: [{ message: { content: "review" } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 800 }
      }
    });

    const result = await complete({ system: "guidelines", prompt: "diff" }, config);

    expect(urlOf(fn)).toBe("https://api.openai.com/v1/chat/completions");
    expect(headersOf(fn).Authorization).toBe("Bearer key");
    expect(bodyOf(fn).messages).toEqual([
      { role: "system", content: "guidelines" },
      { role: "user", content: "diff" }
    ]);
    // inputTokens = prompt_tokens - cached_tokens
    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 30,
      cachedInputTokens: 800
    });
  });

  it("throws on a non-ok response", async () => {
    mockFetch({ error: "bad" }, false, 500);
    await expect(complete({ prompt: "diff" }, config)).rejects.toThrow(/OpenAI API error \(500\)/);
  });
});

describe("gemini provider", () => {
  const config: ProviderConfig = { provider: "gemini", model: "gemini-x", apiKey: "key" };

  it("sends systemInstruction + contents and maps cached usage", async () => {
    const fn = mockFetch({
      candidates: [{ content: { parts: [{ text: "rev" }, { text: "iew" }] } }],
      usageMetadata: {
        promptTokenCount: 500,
        candidatesTokenCount: 40,
        cachedContentTokenCount: 100
      }
    });

    const result = await complete({ system: "guidelines", prompt: "diff" }, config);

    expect(urlOf(fn)).toContain("/models/gemini-x:generateContent");
    expect(headersOf(fn)["x-goog-api-key"]).toBe("key");
    const body = bodyOf(fn);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "guidelines" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "diff" }] }]);
    expect(result.text).toBe("review");
    expect(result.usage).toEqual({
      inputTokens: 400,
      outputTokens: 40,
      cachedInputTokens: 100
    });
  });

  it("throws on a non-ok response", async () => {
    mockFetch({ error: "bad" }, false, 403);
    await expect(complete({ prompt: "diff" }, config)).rejects.toThrow(/Gemini API error \(403\)/);
  });
});
