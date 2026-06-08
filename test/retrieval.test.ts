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
});
