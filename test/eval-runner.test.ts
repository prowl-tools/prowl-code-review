import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBenchmark, loadCase } from "../src/eval/load.js";
import { runBenchmark } from "../src/eval/runner.js";
import { parseDiff } from "../src/review/parse-diff.js";
import type { CompletionResult, ProviderConfig } from "../src/providers/index.js";
import type { ReviewInput, ReviewResult } from "../src/review/run-review.js";
import type { Finding } from "../src/review/findings.js";

const config: ProviderConfig = { provider: "anthropic", model: "test-model", apiKey: "k" };

const BENCH_DIR = join(__dirname, "..", "bench");

function writeCase(
  root: string,
  id: string,
  meta: Record<string, unknown>,
  diff: string
): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "case.json"), JSON.stringify(meta));
  writeFileSync(join(dir, "input.diff"), diff);
}

describe("loadBenchmark", () => {
  it("loads the seed benchmark and validates every case", () => {
    const cases = loadBenchmark(BENCH_DIR);
    expect(cases.length).toBeGreaterThanOrEqual(5);

    // ids are unique and sorted.
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids]).toEqual([...ids].sort((a, b) => a.localeCompare(b)));

    const bugCases = cases.filter((c) => c.kind === "bug");
    const cleanCases = cases.filter((c) => c.kind === "clean");
    expect(bugCases.length).toBeGreaterThan(0);
    expect(cleanCases.length).toBeGreaterThan(0);
  });

  it("each seed bug points at a changed (added) line in its diff", () => {
    // Guards against fixture drift: every expected defect must sit on a line the
    // diff actually adds, so the model can see it and findings can match.
    for (const benchmarkCase of loadBenchmark(BENCH_DIR)) {
      if (benchmarkCase.kind !== "bug") {
        continue;
      }
      const parsed = parseDiff(benchmarkCase.diff);
      const addedByFile = new Map<string, Set<number>>();
      for (const file of parsed.files) {
        const set = new Set<number>();
        for (const hunk of file.hunks) {
          for (const line of hunk.lines) {
            if (line.type === "add" && line.newLine !== undefined) {
              set.add(line.newLine);
            }
          }
        }
        addedByFile.set(file.path, set);
      }
      for (const bug of benchmarkCase.expected) {
        const added = addedByFile.get(bug.file);
        expect(added, `${benchmarkCase.id}: no diff for ${bug.file}`).toBeDefined();
        const last = bug.endLine ?? bug.line;
        const hasAddedLineInRange = [...Array(last - bug.line + 1)].some((_, i) => added?.has(bug.line + i));
        expect(hasAddedLineInRange, `${benchmarkCase.id}: ${bug.file}:${bug.line} not on an added line`).toBe(true);
      }
    }
  });

  it("rejects a bug case with no expected defects", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      writeCase(root, "bad", { description: "d", kind: "bug" }, "diff --git a/x b/x\n+y");
      expect(() => loadCase(join(root, "bad"), "bad")).toThrow(/at least one expected/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when input.diff is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      const dir = join(root, "nodiff");
      mkdirSync(dir);
      writeFileSync(join(dir, "case.json"), JSON.stringify({ description: "d", kind: "clean" }));
      expect(() => loadCase(dir, "nodiff")).toThrow(/missing input\.diff/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runBenchmark", () => {
  function fakeReview(findingsByDiffMarker: (diff: string) => Finding[]) {
    return vi.fn(async (input: ReviewInput): Promise<ReviewResult> => ({
      findings: findingsByDiffMarker(input.diff),
      raw: [],
      passes: [],
      verification: { verified: 0, droppedFalsePositive: 0, demoted: 0, unverified: 0, ok: true },
      judge: { duplicatesRemoved: 0, belowThreshold: 0, belowConfidence: 0, capped: 0 },
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
    }));
  }

  it("scores cases via an injected review pass and stamps the report", async () => {
    const cases = [
      {
        id: "bug1",
        description: "d",
        kind: "bug" as const,
        diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n existing\n+boom();",
        expected: [{ file: "a.ts", line: 2, note: "boom" }]
      },
      {
        id: "clean1",
        description: "d",
        kind: "clean" as const,
        diff: "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,1 +1,2 @@\n existing\n+safe();",
        expected: []
      }
    ];

    // Return a matching finding for the bug case, a noisy one for the clean case.
    const review = fakeReview((diff) =>
      diff.includes("boom")
        ? [{ file: "a.ts", line: 2, severity: "major", category: "correctness", title: "t", body: "b", confidence: 0.9 }]
        : [{ file: "b.ts", line: 2, severity: "minor", category: "correctness", title: "n", body: "b", confidence: 0.9 }]
    );

    const report = await runBenchmark(cases, { config, runReview: review });

    expect(review).toHaveBeenCalledTimes(2);
    expect(report.provider).toBe("anthropic");
    expect(report.model).toBe("test-model");
    expect(report.promptFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(report.match.lineWindow).toBe(3);

    expect(report.metrics.recall).toBe(1); // bug covered
    expect(report.metrics.coveredBugs).toBe(1);
    expect(report.metrics.precision).toBe(0.5); // 1 of 2 findings hit a real bug
    expect(report.metrics.cleanFalseAlarmRate).toBe(1); // 1 noisy finding / 1 clean case
  });

  it("feeds the model a line-annotated rendering of the diff", async () => {
    const cases = [
      {
        id: "render",
        description: "d",
        kind: "clean" as const,
        diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n keep\n+added();",
        expected: []
      }
    ];
    const review = fakeReview(() => []);
    await runBenchmark(cases, { config, runReview: review });

    const seenDiff = review.mock.calls[0][0].diff;
    expect(seenDiff).toContain("### a.ts");
    expect(seenDiff).toContain("+added();");
    expect(seenDiff).toMatch(/2 \+added\(\);/); // new-side line number annotated
  });

  it("marks a case errored when its review throws (excluded from metrics)", async () => {
    const cases = [
      {
        id: "boom",
        description: "d",
        kind: "bug" as const,
        diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n x\n+y",
        expected: [{ file: "a.ts", line: 2, note: "n" }]
      }
    ];
    const review = vi.fn(async (): Promise<ReviewResult> => {
      throw new Error("provider down");
    });

    const report = await runBenchmark(cases, { config, runReview: review });
    expect(report.errored).toBe(1);
    expect(report.cases[0].errored).toBe(true);
    expect(report.cases[0].error).toMatch(/provider down/);
    expect(report.metrics.bugCases).toBe(0); // excluded
  });

  it("forwards review knobs and completion to the review pass", async () => {
    const cases = [
      {
        id: "k",
        description: "d",
        kind: "clean" as const,
        diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n x\n+y",
        expected: []
      }
    ];
    const complete = vi.fn(
      async (): Promise<CompletionResult> => ({ text: "[]", provider: "anthropic", model: "m", usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } })
    );
    const review = vi.fn(async (_input: ReviewInput, options): Promise<ReviewResult> => {
      expect(options?.verify).toBe(false);
      expect(options?.minSeverity).toBe("major");
      expect(options?.complete).toBe(complete);
      return {
        findings: [],
        raw: [],
        passes: [],
        verification: { verified: 0, droppedFalsePositive: 0, demoted: 0, unverified: 0, ok: true },
        judge: { duplicatesRemoved: 0, belowThreshold: 0, belowConfidence: 0, capped: 0 },
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
      };
    });

    await runBenchmark(cases, {
      config,
      complete,
      runReview: review,
      review: { verify: false, minSeverity: "major" }
    });
    expect(review).toHaveBeenCalledTimes(1);
  });
});
