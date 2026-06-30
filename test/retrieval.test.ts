import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/index.js")>();
  return {
    ...actual,
    completeWithTools: vi.fn()
  };
});

import { ContextRetrievalError, gatherContext } from "../src/context/retrieval.js";
import { completeWithTools } from "../src/providers/index.js";
import type { ProviderConfig, ToolCall, ToolCompletionResult } from "../src/providers/index.js";

let root: string;
const config: ProviderConfig = { provider: "anthropic", model: "m", apiKey: "k" };
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "prowl-retrieval-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(
    join(root, ".env"),
    "API_KEY=AKIAIOSFODNN7EXAMPLE\nDATABASE_URL=postgres://user:pass@host/db\n"
  );
  writeFileSync(join(root, "leaked.txt"), `const token = "ghp_${"a".repeat(36)}";\n`);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function toolUse(toolCalls: ToolCall[]): ToolCompletionResult {
  return { text: "", toolCalls, stopReason: "tool_use", usage: USAGE, provider: "anthropic", model: "m" };
}

function end(): ToolCompletionResult {
  return { text: "done", toolCalls: [], stopReason: "end", usage: USAGE, provider: "anthropic", model: "m" };
}

/** A fake tool-use completion that replays scripted responses (clamping at the last). */
function scripted(responses: ToolCompletionResult[]) {
  let i = 0;
  return vi.fn(async () => {
    const response = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return response;
  });
}

describe("gatherContext", () => {
  it("retries transient failures from the default completion (#17)", async () => {
    const completeWithToolsMock = vi.mocked(completeWithTools);
    const retryAttempts: number[] = [];

    completeWithToolsMock
      .mockReset()
      .mockRejectedValueOnce(new Error("Anthropic API error (529): overloaded_error"))
      .mockResolvedValueOnce(end());

    const result = await gatherContext({
      toolkit: { root },
      changedPaths: ["src/a.ts"],
      config,
      retry: {
        sleep: async () => {},
        baseDelayMs: 1,
        random: () => 0,
        onRetry: ({ attempt }) => retryAttempts.push(attempt)
      }
    });

    expect(completeWithToolsMock).toHaveBeenCalledTimes(2);
    expect(retryAttempts).toEqual([1]);
    expect(result.rounds).toBe(1);
    expect(result.reachedLimit).toBe(false);
    expect(result.notes).toEqual([]);
  });

  it("reads a requested file then stops", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "read_file", input: { path: "src/a.ts" } }]),
      end()
    ]);

    const result = await gatherContext({
      toolkit: { root },
      changedPaths: ["src/a.ts"],
      config,
      runCompletion: run
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.rounds).toBe(2);
    expect(result.reachedLimit).toBe(false);
    expect(result.notes).toEqual([]);
    expect(result.files).toEqual([
      { path: "src/a.ts", content: "export const a = 1;\n", truncated: false }
    ]);
    expect(result.usage.inputTokens).toBe(2);
  });

  it("resolves a definition via find_definition (#5)", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "find_definition", input: { symbol: "a" } }]),
      end()
    ]);

    const result = await gatherContext({ toolkit: { root }, changedPaths: ["src/a.ts"], config, runCompletion: run });

    const output = result.toolOutputs.find((o) => o.tool === "find_definition");
    expect(output).toBeDefined();
    expect(output?.input).toMatchObject({ symbol: "a" });
    expect(output?.content).toContain("src/a.ts:1");
    // The fixture's .env is sensitive, so it's skipped (not an error).
    expect(result.notes.every((n) => !/error/i.test(n))).toBe(true);
  });

  it("finds references via find_references (#5)", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "find_references", input: { symbol: "a" } }]),
      end()
    ]);

    const result = await gatherContext({ toolkit: { root }, changedPaths: ["src/a.ts"], config, runCompletion: run });

    const output = result.toolOutputs.find((o) => o.tool === "find_references");
    expect(output?.content).toContain("src/a.ts");
  });

  it("notes an unknown language hint but still resolves the symbol (#5)", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "find_definition", input: { symbol: "a", language: "klingon" } }]),
      end()
    ]);

    const result = await gatherContext({ toolkit: { root }, changedPaths: ["src/a.ts"], config, runCompletion: run });

    expect(result.notes.some((n) => n.includes("Ignored unknown language 'klingon'"))).toBe(true);
    const output = result.toolOutputs.find((o) => o.tool === "find_definition");
    expect(output?.content).toContain("src/a.ts:1");
    expect(output?.input).toEqual({ symbol: "a", dir: "." });
  });

  it("records only applied language filters in symbol tool output (#5)", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "find_definition", input: { symbol: "a", language: "typescript" } }]),
      end()
    ]);

    const result = await gatherContext({ toolkit: { root }, changedPaths: ["src/a.ts"], config, runCompletion: run });

    expect(result.toolOutputs.find((o) => o.tool === "find_definition")?.input).toEqual({
      symbol: "a",
      dir: ".",
      language: "typescript"
    });
    expect(result.notes.some((n) => n.includes("due to search filters"))).toBe(true);
  });

  it("surfaces an invalid-symbol error as a note without throwing (#5)", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "find_definition", input: { symbol: "a b" } }]),
      end()
    ]);

    const result = await gatherContext({ toolkit: { root }, changedPaths: ["src/a.ts"], config, runCompletion: run });

    expect(result.notes.some((n) => n.includes("find_definition error"))).toBe(true);
  });

  it("requires a symbol for find_definition (#5)", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "find_definition", input: {} }]),
      end()
    ]);

    const result = await gatherContext({ toolkit: { root }, changedPaths: ["src/a.ts"], config, runCompletion: run });
    // No tool output recorded; the model is told it needs a symbol.
    expect(result.toolOutputs.find((o) => o.tool === "find_definition")).toBeUndefined();
  });

  it("preserves accumulated usage when a later provider round fails", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(toolUse([{ id: "c1", name: "read_file", input: { path: "src/a.ts" } }]))
      .mockRejectedValueOnce(new Error("provider timeout"));

    try {
      await gatherContext({
        toolkit: { root },
        changedPaths: ["src/a.ts"],
        config,
        runCompletion: run
      });
      throw new Error("Expected gatherContext to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextRetrievalError);
      expect((error as ContextRetrievalError).message).toBe("provider timeout");
      expect((error as ContextRetrievalError).usage).toEqual(USAGE);
      expect((error as ContextRetrievalError).rounds).toBe(2);
    }
  });

  it("stops at maxRounds and reports the limit", async () => {
    const run = scripted([toolUse([{ id: "c1", name: "read_file", input: { path: "src/a.ts" } }])]);

    const result = await gatherContext({
      toolkit: { root },
      changedPaths: ["src/a.ts"],
      config,
      limits: { maxRounds: 3 },
      runCompletion: run
    });

    expect(result.rounds).toBe(3);
    expect(result.reachedLimit).toBe(true);
    expect(result.notes.some((n) => n.includes("max tool rounds"))).toBe(true);
  });

  it("surfaces tool errors as notes without throwing", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "read_file", input: { path: "src/missing.ts" } }]),
      end()
    ]);

    const result = await gatherContext({
      toolkit: { root },
      changedPaths: ["src/missing.ts"],
      config,
      runCompletion: run
    });

    expect(result.files).toEqual([]);
    expect(result.notes.some((n) => n.includes("read_file error"))).toBe(true);
  });

  it("contains model-supplied path traversal attempts inside tool errors", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "read_file", input: { path: "../secret.txt" } }]),
      end()
    ]);

    const result = await gatherContext({
      toolkit: { root },
      changedPaths: ["src/a.ts"],
      config,
      runCompletion: run
    });

    expect(result.files).toEqual([]);
    expect(result.notes.some((n) => n.includes("escapes repo root"))).toBe(true);
  });

  it("contains unsafe model-supplied search regexes inside tool errors", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "search_repo", input: { pattern: "(a+)+$" } }]),
      end()
    ]);

    const result = await gatherContext({
      toolkit: { root },
      changedPaths: ["src/a.ts"],
      config,
      runCompletion: run
    });

    expect(result.toolOutputs).toEqual([]);
    expect(result.notes.some((n) => n.includes("Unsafe search pattern"))).toBe(true);
  });

  it("preserves provider metadata on assistant tool turns", async () => {
    const metadata = {
      geminiParts: [
        { type: "text" as const, text: "checking", thoughtSignature: "text-sig" },
        {
          type: "functionCall" as const,
          id: "c1",
          name: "read_file",
          input: { path: "src/a.ts" },
          thoughtSignature: "call-sig"
        }
      ]
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        ...toolUse([{ id: "c1", name: "read_file", input: { path: "src/a.ts" } }]),
        providerMetadata: metadata
      })
      .mockImplementationOnce(async (request) => {
        expect(request.messages[1]).toMatchObject({ providerMetadata: metadata });
        return end();
      });

    await gatherContext({
      toolkit: { root },
      changedPaths: ["src/a.ts"],
      config,
      runCompletion: run
    });
  });

  it("enforces the file budget", async () => {
    const run = scripted([
      toolUse([
        { id: "c1", name: "read_file", input: { path: "src/a.ts" } },
        { id: "c2", name: "read_file", input: { path: "src/b.ts" } }
      ]),
      end()
    ]);

    const result = await gatherContext({
      toolkit: { root },
      changedPaths: ["src/a.ts", "src/b.ts"],
      config,
      limits: { maxFiles: 1 },
      runCompletion: run
    });

    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(result.reachedLimit).toBe(true);
    expect(result.notes.some((n) => n.includes("File budget reached"))).toBe(true);
  });

  it("reports truncated file listings", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "list_files", input: {} }]),
      end()
    ]);

    const result = await gatherContext({
      toolkit: { root, maxListedFiles: 1 },
      changedPaths: ["src/a.ts"],
      config,
      runCompletion: run
    });

    expect(result.reachedLimit).toBe(true);
    expect(result.notes.some((n) => n.includes("more omitted"))).toBe(true);
  });

  it("returns successful search outputs even when no file is read", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "search_repo", input: { pattern: "export const", dir: "src" } }]),
      end()
    ]);

    const result = await gatherContext({
      toolkit: { root },
      changedPaths: ["src/a.ts"],
      config,
      runCompletion: run
    });

    expect(result.files).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.toolOutputs).toEqual([
      {
        tool: "search_repo",
        input: { pattern: "export const", dir: "src" },
        content: "src/a.ts:1: export const a = 1;\nsrc/b.ts:1: export const b = 2;",
        truncated: false
      }
    ]);
  });

  it("omits search matches from sensitive files before exposing tool output", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "search_repo", input: { pattern: "DATABASE_URL|export const" } }]),
      end()
    ]);

    const result = await gatherContext({
      toolkit: { root },
      changedPaths: ["src/a.ts"],
      config,
      runCompletion: run
    });

    expect(result.toolOutputs[0]?.content).toContain("src/a.ts");
    expect(result.toolOutputs[0]?.content).not.toContain(".env");
    expect(result.toolOutputs[0]?.content).not.toContain("postgres://user:pass@host/db");
    expect(result.notes.some((n) => n.includes("sensitive file") && n.includes("search"))).toBe(true);
  });

  it("does not count sensitive search files against the match cap", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "search_repo", input: { pattern: "DATABASE_URL|export const" } }]),
      end()
    ]);

    const result = await gatherContext({
      toolkit: { root, maxMatches: 1 },
      changedPaths: ["src/a.ts"],
      config,
      runCompletion: run
    });

    expect(result.toolOutputs[0]?.content).toContain("src/a.ts");
    expect(result.toolOutputs[0]?.content).not.toContain(".env");
    expect(result.toolOutputs[0]?.content).not.toContain("postgres://user:pass@host/db");
    expect(result.notes.some((n) => n.includes("sensitive file") && n.includes("search"))).toBe(true);
  });

  it("returns successful file listing outputs even when no file is read", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "list_files", input: { dir: "src" } }]),
      end()
    ]);

    const result = await gatherContext({
      toolkit: { root },
      changedPaths: ["src/a.ts"],
      config,
      runCompletion: run
    });

    expect(result.files).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.toolOutputs).toEqual([
      {
        tool: "list_files",
        input: { dir: "src" },
        content: "src/a.ts\nsrc/b.ts",
        truncated: false
      }
    ]);
  });

  it("refuses to read sensitive files into context", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "read_file", input: { path: ".env" } }]),
      end()
    ]);

    const result = await gatherContext({ toolkit: { root }, changedPaths: [".env"], config, runCompletion: run });

    expect(result.files).toEqual([]);
    expect(result.notes.some((n) => n.includes("Refused to read sensitive file"))).toBe(true);
  });

  it("redacts secrets from fetched file content", async () => {
    const run = scripted([
      toolUse([{ id: "c1", name: "read_file", input: { path: "leaked.txt" } }]),
      end()
    ]);

    const result = await gatherContext({ toolkit: { root }, changedPaths: ["leaked.txt"], config, runCompletion: run });

    const file = result.files.find((f) => f.path === "leaked.txt");
    expect(file?.content).not.toContain("ghp_aaaa");
    expect(file?.content).toContain("[REDACTED");
    expect(result.notes.some((n) => n.includes("Redacted"))).toBe(true);
  });

  it("stops the retrieval loop once the token budget is spent (#18)", async () => {
    // Each round spends USAGE (2 tokens). The agent keeps requesting tools, but a
    // 3-token budget halts the loop after the second round (accumulated 4 ≥ 3).
    const run = scripted([toolUse([{ id: "c1", name: "read_file", input: { path: "src/a.ts" } }])]);

    const result = await gatherContext({
      toolkit: { root },
      changedPaths: ["src/a.ts"],
      config,
      runCompletion: run,
      limits: { maxTokens: 3 }
    });

    expect(result.rounds).toBe(2);
    expect(result.reachedLimit).toBe(true);
    expect(result.notes.some((n) => n.includes("context token budget"))).toBe(true);
  });
});
