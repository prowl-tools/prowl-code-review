import { afterEach, describe, expect, it, vi } from "vitest";
import {
  complete,
  resolveProviderConfig,
  DEFAULT_MODELS,
  type ProviderConfig
} from "../src/providers/index.js";

type Json = Record<string, unknown>;
type FetchMock = ReturnType<typeof vi.fn>;

/** Build a mock `fetch` returning the given JSON payload. */
function mockFetch(payload: Json, ok = true, status = 200, responseText?: string) {
  const fn = vi.fn(async () => ({
    ok,
    status,
    json: async () => payload,
    text: async () => responseText ?? JSON.stringify(payload)
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Parse the JSON body passed to the mocked fetch's first call. */
function bodyOf(fn: FetchMock): Json {
  const init = initOf(fn);
  if (typeof init.body !== "string") {
    throw new Error("expected mocked fetch call to include a JSON string body");
  }
  return JSON.parse(init.body) as Json;
}

/** Return the URL from the mocked fetch's first call. */
function urlOf(fn: FetchMock): string {
  const url = fn.mock.calls[0]?.[0];
  if (typeof url !== "string") {
    throw new Error("expected mocked fetch call to include a URL string");
  }
  return url;
}

/** Return the headers from the mocked fetch's first call. */
function headersOf(fn: FetchMock): Record<string, string> {
  const init = initOf(fn);
  if (!init.headers || init.headers instanceof Headers || Array.isArray(init.headers)) {
    throw new Error("expected mocked fetch call to include object headers");
  }
  return init.headers;
}

/** Return the HTTP method from the mocked fetch's first call. */
function methodOf(fn: FetchMock): string | undefined {
  return initOf(fn).method;
}

/** Return the request init from the mocked fetch's first call. */
function initOf(fn: FetchMock): RequestInit {
  const init = fn.mock.calls[0]?.[1];
  if (!init || typeof init !== "object") {
    throw new Error("expected mocked fetch to have been called with request init");
  }
  return init as RequestInit;
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

  it("treats an empty model override as unset", () => {
    const cfg = resolveProviderConfig({
      PROWL_AI_PROVIDER: "gemini",
      PROWL_AI_KEY: "k",
      PROWL_AI_MODEL: ""
    } as NodeJS.ProcessEnv);
    expect(cfg.model).toBe(DEFAULT_MODELS.gemini);
  });

  it("uses a published OpenAI default model", () => {
    const cfg = resolveProviderConfig({
      PROWL_AI_PROVIDER: "openai",
      PROWL_AI_KEY: "k"
    } as NodeJS.ProcessEnv);
    expect(cfg.model).toBe("gpt-5.2");
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
    expect(methodOf(fn)).toBe("POST");
    expect(headersOf(fn)["x-api-key"]).toBe("key");
    const body = bodyOf(fn);
    expect(body.max_tokens).toBe(4096);
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

  it("counts cache creation tokens as uncached input", async () => {
    const fn = mockFetch({
      content: [{ type: "text", text: "review" }],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 900
      }
    });

    const result = await complete({ system: "guidelines", prompt: "diff" }, config);

    expect(urlOf(fn)).toBe("https://api.anthropic.com/v1/messages");
    expect(result.usage).toEqual({
      inputTokens: 400,
      outputTokens: 20,
      cachedInputTokens: 900
    });
  });

  it("defaults missing cache read tokens to zero", async () => {
    mockFetch({
      content: [{ type: "text", text: "review" }],
      usage: { input_tokens: 100, output_tokens: 20 }
    });

    const result = await complete({ system: "guidelines", prompt: "diff" }, config);

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0
    });
  });

  it("defaults missing usage to zero tokens", async () => {
    mockFetch({ content: [{ type: "text", text: "review" }] });

    const result = await complete({ system: "guidelines", prompt: "diff" }, config);

    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0
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
    expect(methodOf(fn)).toBe("POST");
    expect(headersOf(fn).Authorization).toBe("Bearer key");
    const body = bodyOf(fn);
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.messages).toEqual([
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

  it("defaults missing prompt token details to zero cached input", async () => {
    mockFetch({
      choices: [{ message: { content: "review" } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 30
      }
    });

    const result = await complete({ system: "guidelines", prompt: "diff" }, config);

    expect(result.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 30,
      cachedInputTokens: 0
    });
  });

  it("defaults missing cached tokens to zero cached input", async () => {
    mockFetch({
      choices: [{ message: { content: "review" } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 30,
        prompt_tokens_details: {}
      }
    });

    const result = await complete({ system: "guidelines", prompt: "diff" }, config);

    expect(result.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 30,
      cachedInputTokens: 0
    });
  });

  it("defaults missing usage to zero tokens", async () => {
    mockFetch({ choices: [{ message: { content: "review" } }] });

    const result = await complete({ system: "guidelines", prompt: "diff" }, config);

    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0
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

    expect(urlOf(fn)).toContain("/v1beta/models/gemini-x:generateContent");
    expect(methodOf(fn)).toBe("POST");
    expect(headersOf(fn)["x-goog-api-key"]).toBe("key");
    const body = bodyOf(fn);
    expect((body.generationConfig as Json).maxOutputTokens).toBe(4096);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "guidelines" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "diff" }] }]);
    expect(result.text).toBe("review");
    expect(result.usage).toEqual({
      inputTokens: 400,
      outputTokens: 40,
      cachedInputTokens: 100
    });
  });

  it("defaults missing cached content token count to zero cached input", async () => {
    mockFetch({
      candidates: [{ content: { parts: [{ text: "review" }] } }],
      usageMetadata: {
        promptTokenCount: 500,
        candidatesTokenCount: 40
      }
    });

    const result = await complete({ system: "guidelines", prompt: "diff" }, config);

    expect(result.usage).toEqual({
      inputTokens: 500,
      outputTokens: 40,
      cachedInputTokens: 0
    });
  });

  it("defaults missing usage metadata to zero tokens", async () => {
    mockFetch({ candidates: [{ content: { parts: [{ text: "review" }] } }] });

    const result = await complete({ system: "guidelines", prompt: "diff" }, config);

    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0
    });
  });

  it("throws on a non-ok response", async () => {
    mockFetch({ error: "bad" }, false, 403);
    await expect(complete({ prompt: "diff" }, config)).rejects.toThrow(/Gemini API error \(403\)/);
  });

  it("adds a model-availability hint on 404 responses", async () => {
    mockFetch({ error: "not found" }, false, 404);
    await expect(complete({ prompt: "diff" }, config)).rejects.toThrow(
      /model "gemini-x" may be unavailable/
    );
  });

  it("uses a fallback detail when an error response body is empty", async () => {
    mockFetch({}, false, 500, "");
    await expect(complete({ prompt: "diff" }, config)).rejects.toThrow(/\(no response body\)/);
  });

  it("throws when a successful response contains no text content", async () => {
    mockFetch({ candidates: [{ content: { parts: [{}] } }] });
    await expect(complete({ prompt: "diff" }, config)).rejects.toThrow(/Gemini API returned no content/);
  });
});
