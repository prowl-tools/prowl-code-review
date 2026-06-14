import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeWithTools,
  type ProviderConfig,
  type ToolDefinition,
  type ToolMessage
} from "../src/providers/index.js";

type Json = Record<string, unknown>;
type FetchMock = ReturnType<typeof vi.fn>;

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

function bodyOf(fn: FetchMock): Json {
  const init = fn.mock.calls[0]?.[1] as { body: string };
  return JSON.parse(init.body) as Json;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  }
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("anthropic completeWithTools", () => {
  const config: ProviderConfig = { provider: "anthropic", model: "claude-x", apiKey: "key" };

  it("sends tools + serialized messages and parses tool calls", async () => {
    const fn = mockFetch({
      content: [
        { type: "text", text: "looking" },
        { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } }
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 }
    });

    const messages: ToolMessage[] = [{ role: "user", text: "review this" }];
    const result = await completeWithTools({ system: "sys", messages, tools: TOOLS }, config);

    const body = bodyOf(fn);
    expect(body.tools).toEqual([
      {
        name: "read_file",
        description: "Read a file.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
      }
    ]);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "review this" }] }]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.text).toBe("looking");
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "read_file", input: { path: "a.ts" } }]);
  });

  it("serializes assistant tool calls and tool results into a conversation", async () => {
    const fn = mockFetch({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn" });
    const messages: ToolMessage[] = [
      { role: "user", text: "go" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", input: { path: "a.ts" } }] },
      { role: "tool", results: [{ callId: "c1", content: "file body" }] }
    ];

    const result = await completeWithTools({ messages, tools: TOOLS }, config);

    const body = bodyOf(fn) as { messages: Array<{ role: string; content: unknown[] }> };
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } }]
    });
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: "file body" }]
    });
    expect(result.stopReason).toBe("end");
    expect(result.toolCalls).toEqual([]);
  });
});

describe("openai completeWithTools", () => {
  const config: ProviderConfig = { provider: "openai", model: "gpt-x", apiKey: "key" };

  it("sends function tools and parses tool_calls", async () => {
    const fn = mockFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "call_1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }
            ]
          },
          finish_reason: "tool_calls"
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    });

    const result = await completeWithTools(
      { system: "sys", messages: [{ role: "user", text: "go" }], tools: TOOLS },
      config
    );

    const body = bodyOf(fn) as { tools: Array<{ type: string }>; messages: Array<{ role: string }> };
    expect(body.tools[0].type).toBe("function");
    expect(body.messages[0].role).toBe("system");
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "read_file", input: { path: "a.ts" } }]);
  });
});

describe("gemini completeWithTools", () => {
  const config: ProviderConfig = { provider: "gemini", model: "gemini-x", apiKey: "key" };

  it("sends functionDeclarations and parses functionCall parts", async () => {
    const fn = mockFetch({
      candidates: [
        {
          content: {
            parts: [
              { text: "ok" },
              { functionCall: { id: "call_1", name: "read_file", args: { path: "a.ts" } } }
            ]
          }
        }
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 }
    });

    const result = await completeWithTools(
      { messages: [{ role: "user", text: "go" }], tools: TOOLS },
      config
    );

    const body = bodyOf(fn) as { tools: Array<{ functionDeclarations: unknown[] }> };
    expect(body.tools[0].functionDeclarations).toHaveLength(1);
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "read_file", input: { path: "a.ts" } }]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 8, cachedInputTokens: 0 });
  });

  it("sends safety settings and bounded thinking config for tool requests", async () => {
    const fn = mockFetch({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { id: "call_1", name: "read_file", args: { path: "a.ts" } } }]
          }
        }
      ]
    });

    await completeWithTools(
      { messages: [{ role: "user", text: "go" }], tools: TOOLS, maxTokens: 129, temperature: 0.2 },
      { provider: "gemini", model: "gemini-2.5-pro", apiKey: "key" }
    );

    const body = bodyOf(fn) as { generationConfig: Json; safetySettings: Array<Json> };
    expect(body.generationConfig).toMatchObject({
      maxOutputTokens: 129,
      temperature: 0.2,
      thinkingConfig: { thinkingBudget: 128 }
    });
    expect(body.safetySettings).toHaveLength(4);
    expect(body.safetySettings.every((setting) => setting.threshold === "BLOCK_NONE")).toBe(true);
  });

  it("echoes function-call ids in follow-up function responses", async () => {
    const fn = mockFetch({ candidates: [{ content: { parts: [{ text: "done" }] } }] });
    const messages: ToolMessage[] = [
      { role: "user", text: "go" },
      { role: "assistant", text: "", toolCalls: [{ id: "call_1", name: "read_file", input: { path: "a.ts" } }] },
      { role: "tool", results: [{ callId: "call_1", content: "file body" }] }
    ];

    const result = await completeWithTools({ messages, tools: TOOLS }, config);

    const body = bodyOf(fn) as { contents: Array<{ parts: unknown[] }> };
    expect(body.contents[1].parts).toEqual([
      { functionCall: { id: "call_1", name: "read_file", args: { path: "a.ts" } } }
    ]);
    expect(body.contents[2].parts).toEqual([
      { functionResponse: { id: "call_1", name: "read_file", response: { result: "file body" } } }
    ]);
    expect(result.stopReason).toBe("end");
  });

  it("captures and echoes Gemini thought signatures across ordered parts", async () => {
    // Parsing: Gemini can sign text parts alongside function-call parts.
    const parseFn = mockFetch({
      candidates: [
        {
          content: {
            parts: [
              { text: "checking", thoughtSignature: "text-sig" },
              {
                functionCall: { id: "call_1", name: "read_file", args: { path: "a.ts" } },
                thoughtSignature: "call-sig"
              }
            ]
          }
        }
      ]
    });
    const parsed = await completeWithTools({ messages: [{ role: "user", text: "go" }], tools: TOOLS }, config);
    expect(parseFn).toHaveBeenCalled();
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]).toMatchObject({
      id: "call_1",
      name: "read_file",
      thoughtSignature: "call-sig"
    });
    expect(parsed.providerMetadata?.geminiParts).toEqual([
      { type: "text", text: "checking", thoughtSignature: "text-sig" },
      {
        type: "functionCall",
        id: "call_1",
        name: "read_file",
        input: { path: "a.ts" },
        thoughtSignature: "call-sig"
      }
    ]);

    // Serialization: every signed part is echoed back in Gemini's original order.
    const echoFn = mockFetch({ candidates: [{ content: { parts: [{ text: "done" }] } }] });
    await completeWithTools(
      {
        messages: [
          { role: "user", text: "go" },
          {
            role: "assistant",
            text: parsed.text,
            toolCalls: parsed.toolCalls,
            providerMetadata: parsed.providerMetadata
          },
          { role: "tool", results: [{ callId: "call_1", content: "body" }] }
        ],
        tools: TOOLS
      },
      config
    );
    const body = bodyOf(echoFn) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(body.contents[1].parts).toEqual([
      { text: "checking", thoughtSignature: "text-sig" },
      {
        functionCall: { id: "call_1", name: "read_file", args: { path: "a.ts" } },
        thoughtSignature: "call-sig"
      }
    ]);
  });

  it("adds a model-availability hint on tool-call 404 responses", async () => {
    mockFetch({ error: "not found" }, false, 404);

    await expect(
      completeWithTools({ messages: [{ role: "user", text: "go" }], tools: TOOLS }, config)
    ).rejects.toThrow(/model "gemini-x" may be unavailable/);
  });
});
