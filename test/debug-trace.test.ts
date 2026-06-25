import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
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

  it("writes one parseable JSON line per event, flushed as it goes (partial-run safe)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prowl-debug-"));
    const path = join(dir, "trace.jsonl");
    const sink = createJsonlSink(path, { now: clock([0, 10, 20]) });

    sink({ type: "diff", reviewedFiles: 2, skippedFiles: 1 });
    // After the first event the file is already readable (streamed, not buffered).
    const afterOne = readFileSync(path, "utf8").trim().split("\n");
    expect(afterOne).toHaveLength(1);

    sink({ type: "run-end", findings: 0, posted: false });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const records = lines.map((line) => JSON.parse(line) as DebugRecord);
    expect(records[0].event.type).toBe("diff");
    expect(records[1].event.type).toBe("run-end");
    expect(records.map((r) => r.seq)).toEqual([0, 1]);
  });

  it("never throws into the caller when the write fails", () => {
    const sink = createJsonlSink("/this/path/does/not/exist/trace.jsonl");
    expect(() => sink({ type: "run-end", findings: 0, posted: true })).not.toThrow();
  });
});
