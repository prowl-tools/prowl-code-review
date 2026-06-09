import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherContext } from "../src/context/retrieval.js";
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
});
