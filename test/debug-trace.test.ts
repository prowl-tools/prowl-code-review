import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDebugRecorder,
  createJsonlSink,
  toDebugFindings,
  type DebugEvent,
  type DebugRecord
} from "../src/debug/trace.js";
import type { Finding } from "../src/review/findings.js";

const SECRET = "sk-ant-abcdef0123456789ABCDEFXYZ";

function clock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

async function waitForTrace(path: string, lines: number): Promise<string[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8").trim();
      const parsed = content ? content.split("\n") : [];
      if (parsed.length >= lines) {
        return parsed;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${lines} trace line(s).`);
}

describe("debug trace", () => {
  it("stamps events with an increasing sequence and relative timestamp", () => {
    // start=100; then 130, 175 for two emits.
    const { sink, records } = createDebugRecorder({ now: clock([100, 130, 175]) });
    sink({ type: "grounding", findings: 2, notes: 1 });
    sink({ type: "run-end", findings: 3, posted: true });

    expect(records.map((r) => r.seq)).toEqual([0, 1]);
    expect(records.map((r) => r.t)).toEqual([30, 75]);
    expect(records[0].event.type).toBe("grounding");
  });

  it("redacts secrets from string fields anywhere in the event (#15)", () => {
    const { sink, records } = createDebugRecorder({ now: clock([0]) });
    const event: DebugEvent = {
      type: "prompt",
      provider: "anthropic",
      model: "m",
      pass: "security",
      system: "be strict",
      prompt: `review this token ${SECRET} now`
    };
    sink(event);

    const stored = records[0].event as Extract<DebugEvent, { type: "prompt" }>;
    expect(stored.prompt).not.toContain(SECRET);
    expect(stored.prompt).toContain("[REDACTED:llm-key]");
  });

  it("redacts secrets nested in arrays and objects", () => {
    const { sink, records } = createDebugRecorder({ now: clock([0]) });
    sink({
      type: "pass",
      provider: "anthropic",
      model: "m",
      pass: "security",
      ok: true,
      retried: false,
      findings: [{ severity: "major", confidence: 0.9, title: `leak ${SECRET}` }]
    });
    const stored = records[0].event as Extract<DebugEvent, { type: "pass" }>;
    expect(stored.findings[0].title).toContain("[REDACTED:llm-key]");
    expect(JSON.stringify(stored)).not.toContain(SECRET);
  });

  it("toDebugFindings keeps the maintainer-relevant fields and drops the rest", () => {
    const findings: Finding[] = [
      {
        file: "a.ts",
        line: 5,
        severity: "critical",
        category: "security",
        title: "SQLi",
        body: "long body text",
        confidence: 0.9,
        sources: ["anthropic", "gemini"]
      }
    ];
    expect(toDebugFindings(findings)).toEqual([
      {
        file: "a.ts",
        line: 5,
        severity: "critical",
        category: "security",
        title: "SQLi",
        confidence: 0.9,
        sources: ["anthropic", "gemini"]
      }
    ]);
  });

  it("writes one parseable JSON line per event in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prowl-debug-"));
    const path = join(dir, "trace.jsonl");
    const sink = createJsonlSink(path, { now: clock([0, 10, 20]) });

    sink({ type: "diff", reviewedFiles: 2, skippedFiles: 1 });
    const afterOne = await waitForTrace(path, 1);
    expect(afterOne).toHaveLength(1);

    sink({ type: "run-end", findings: 0, posted: false });
    const lines = await waitForTrace(path, 2);
    expect(lines).toHaveLength(2);
    const records = lines.map((line) => JSON.parse(line) as DebugRecord);
    expect(records[0].event.type).toBe("diff");
    expect(records[1].event.type).toBe("run-end");
    expect(records.map((r) => r.seq)).toEqual([0, 1]);
  });

  it("creates parent directories for nested trace paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prowl-debug-"));
    const path = join(dir, "traces", "run.jsonl");
    const sink = createJsonlSink(path, { now: clock([0, 5]) });

    sink({ type: "run-end", findings: 0, posted: false });

    const lines = await waitForTrace(path, 1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: { type: "run-end" } });
  });

  it("writes workspace-relative trace paths inside the workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "prowl-debug-workspace-"));
    const path = join(workspace, "traces", "relative.jsonl");
    const sink = createJsonlSink("traces/relative.jsonl", { workspace });

    sink({ type: "run-end", findings: 0, posted: false });

    const lines = await waitForTrace(path, 1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: { type: "run-end" } });
  });

  it("rejects symlinked workspace paths at write time", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "prowl-debug-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "prowl-debug-outside-"));
    symlinkSync(outside, join(workspace, "traces"), "dir");
    const path = join(workspace, "traces", "run.jsonl");
    const sink = createJsonlSink(path, { workspace });

    expect(() => sink({ type: "run-end", findings: 0, posted: false })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(existsSync(join(outside, "run.jsonl"))).toBe(false);
  });

  it("does not create nested trace parents through a symlink", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "prowl-debug-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "prowl-debug-outside-"));
    symlinkSync(outside, join(workspace, "traces"), "dir");
    const sink = createJsonlSink(join(workspace, "traces", "nested", "run.jsonl"), { workspace });

    expect(() => sink({ type: "run-end", findings: 0, posted: false })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(existsSync(join(outside, "nested"))).toBe(false);
  });

  it("rejects a symlinked final trace file at write time", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "prowl-debug-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "prowl-debug-outside-"));
    const outsideTrace = join(outside, "trace.jsonl");
    writeFileSync(outsideTrace, "");
    symlinkSync(outsideTrace, join(workspace, "trace.jsonl"), "file");
    const sink = createJsonlSink(join(workspace, "trace.jsonl"), { workspace });

    expect(() => sink({ type: "run-end", findings: 0, posted: false })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(readFileSync(outsideTrace, "utf8")).toBe("");
  });

  it("never throws into the caller when the write fails", () => {
    const sink = createJsonlSink("/this/path/does/not/exist/trace.jsonl");
    expect(() => sink({ type: "run-end", findings: 0, posted: true })).not.toThrow();
  });
});
