import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBenchmark, loadCase } from "../src/eval/load.js";
import { runBenchmark } from "../src/eval/runner.js";
import { parseDiff } from "../src/review/parse-diff.js";
import {
  DEFAULT_MAX_FINDINGS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_SEVERITY
} from "../src/review/judge.js";
import { DEFAULT_VERIFY_CONFIDENCE } from "../src/review/verify.js";
import type { CompletionResult, ProviderConfig } from "../src/providers/index.js";
import type { ReviewInput, ReviewResult } from "../src/review/run-review.js";
import type { Finding } from "../src/review/findings.js";

const config: ProviderConfig = { provider: "anthropic", model: "test-model", apiKey: "k" };

const BENCH_DIR = join(__dirname, "..", "bench");

const defaultReviewSettings = {
  verify: true,
  minSeverity: DEFAULT_MIN_SEVERITY,
  minConfidence: DEFAULT_MIN_CONFIDENCE,
  maxFindings: DEFAULT_MAX_FINDINGS,
  verifyConfidence: DEFAULT_VERIFY_CONFIDENCE
};

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

  it("throws when the benchmark path is missing or not a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      expect(() => loadBenchmark(join(root, "missing"))).toThrow(/Benchmark directory not found/);

      const filePath = join(root, "file");
      writeFileSync(filePath, "not a directory");
      expect(() => loadBenchmark(filePath)).toThrow(/Benchmark directory not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when case.json is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      const dir = join(root, "nometa");
      mkdirSync(dir);
      expect(() => loadCase(dir, "nometa")).toThrow(/missing case\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when case.json contains malformed JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      const dir = join(root, "badjson");
      mkdirSync(dir);
      writeFileSync(join(dir, "case.json"), "{not json");
      writeFileSync(join(dir, "input.diff"), "diff --git a/x b/x\n+y");
      expect(() => loadCase(dir, "badjson")).toThrow(/badjson.*invalid case\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when two case directories declare the same id", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      writeCase(root, "a", { id: "same", description: "d", kind: "clean" }, "diff --git a/a b/a\n+y");
      writeCase(root, "b", { id: "same", description: "d", kind: "clean" }, "diff --git a/b b/b\n+y");
      expect(() => loadBenchmark(root)).toThrow(/Duplicate benchmark case id: same/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a clean case that lists expected defects", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      writeCase(
        root,
        "noisy-clean",
        { description: "d", kind: "clean", expected: [{ file: "x.ts", line: 1, note: "n" }] },
        "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n x\n+y"
      );
      expect(() => loadCase(join(root, "noisy-clean"), "noisy-clean")).toThrow(/noisy-clean.*must not list expected defects/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects expected bug ranges where endLine precedes line", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      writeCase(
        root,
        "bad-range",
        { description: "d", kind: "bug", expected: [{ file: "x.ts", line: 4, endLine: 3, note: "n" }] },
        "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,4 @@\n x\n+y\n+z\n+w"
      );
      expect(() => loadCase(join(root, "bad-range"), "bad-range")).toThrow(/bad-range.*endLine must be greater than or equal to line/);
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
    expect(report.review).toEqual(defaultReviewSettings);

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

  it("filters sensitive files and redacts secrets before review", async () => {
    const cases = [
      {
        id: "safe-input",
        description: "d",
        kind: "clean" as const,
        diff: `diff --git a/.env b/.env
new file mode 100644
--- /dev/null
+++ b/.env
@@ -0,0 +1 @@
+API_KEY=AKIAIOSFODNN7EXAMPLE
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
 const a = 1;
+const t = "ghp_${"a".repeat(36)}";
diff --git a/.env b/config/example.txt
similarity index 72%
rename from .env
rename to config/example.txt
--- a/.env
+++ b/config/example.txt
@@ -1 +1 @@
-DATABASE_URL=postgres://user:pass@host/db
+DATABASE_URL=postgres://user:pass@host/db
`,
        context: `token sk-${"A".repeat(24)}`,
        expected: []
      }
    ];
    const review = fakeReview(() => []);
    await runBenchmark(cases, { config, runReview: review });

    const input = review.mock.calls[0][0];
    expect(input.diff).not.toContain(".env");
    expect(input.diff).not.toContain("config/example.txt");
    expect(input.diff).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(input.diff).not.toContain("postgres://user:pass@host/db");
    expect(input.diff).not.toContain("ghp_aaaa");
    expect(input.diff).toContain("src/a.ts");
    expect(input.diff).toContain("[REDACTED:github-token]");
    expect(input.context).toBe("token [REDACTED:llm-key]");
  });

  it("applies diff limits before rendering the review input", async () => {
    const cases = [
      {
        id: "limited",
        description: "d",
        kind: "clean" as const,
        diff: [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1,2 @@",
          " const a = 1;",
          "+a();",
          "diff --git a/b.ts b/b.ts",
          "--- a/b.ts",
          "+++ b/b.ts",
          "@@ -1 +1,2 @@",
          " const b = 1;",
          "+b();"
        ].join("\n"),
        expected: []
      }
    ];
    const review = fakeReview(() => []);
    await runBenchmark(cases, { config, runReview: review, diffLimits: { maxFiles: 1 } });

    const input = review.mock.calls[0][0];
    expect(input.diff).toContain("### a.ts");
    expect(input.diff).not.toContain("### b.ts");
  });

  it("marks unparsable benchmark diffs as errored without calling review", async () => {
    const review = fakeReview(() => []);
    const report = await runBenchmark(
      [
        {
          id: "not-a-diff",
          description: "d",
          kind: "clean" as const,
          diff: "this is not a git diff",
          expected: []
        },
        {
          id: "no-hunk",
          description: "d",
          kind: "clean" as const,
          diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+orphan();",
          expected: []
        }
      ],
      { config, runReview: review }
    );

    expect(review).not.toHaveBeenCalled();
    expect(report.errored).toBe(2);
    expect(report.cases[0].error).toMatch(/no changed files/);
    expect(report.cases[1].error).toMatch(/no textual hunks/);
    expect(report.metrics.cleanCases).toBe(0);
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

  it("marks a case errored when every specialist pass fails", async () => {
    const cases = [
      {
        id: "all-failed",
        description: "d",
        kind: "clean" as const,
        diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n x\n+y",
        expected: []
      }
    ];
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      findings: [],
      raw: [],
      passes: [
        { specialist: "correctness", findings: 0, ok: false, error: "provider down" },
        { specialist: "security", findings: 0, ok: false, error: "model unavailable" }
      ],
      verification: { verified: 0, droppedFalsePositive: 0, demoted: 0, unverified: 0, ok: true },
      judge: { duplicatesRemoved: 0, belowThreshold: 0, belowConfidence: 0, capped: 0 },
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
    }));

    const report = await runBenchmark(cases, { config, runReview: review });
    expect(report.errored).toBe(1);
    expect(report.cases[0].errored).toBe(true);
    expect(report.cases[0].error).toContain("All review specialist passes failed");
    expect(report.cases[0].error).toContain("correctness: provider down");
    expect(report.metrics.cleanCases).toBe(0); // excluded
  });

  it("marks a case errored when verification fails", async () => {
    const cases = [
      {
        id: "verify-failed",
        description: "d",
        kind: "bug" as const,
        diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n x\n+y",
        expected: [{ file: "a.ts", line: 2, note: "n" }]
      }
    ];
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      findings: [
        {
          file: "a.ts",
          line: 2,
          severity: "major",
          category: "correctness",
          title: "t",
          body: "b",
          confidence: 0.6
        }
      ],
      raw: [],
      passes: [{ specialist: "correctness", findings: 1, ok: true }],
      verification: {
        verified: 1,
        droppedFalsePositive: 0,
        demoted: 0,
        unverified: 1,
        ok: false,
        error: "verifier unavailable"
      },
      judge: { duplicatesRemoved: 0, belowThreshold: 0, belowConfidence: 0, capped: 0 },
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
    }));

    const report = await runBenchmark(cases, { config, runReview: review });
    expect(report.errored).toBe(1);
    expect(report.cases[0].errored).toBe(true);
    expect(report.cases[0].error).toBe("Review verification failed: verifier unavailable");
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

    const report = await runBenchmark(cases, {
      config,
      complete,
      runReview: review,
      review: { verify: false, minSeverity: "major" }
    });
    expect(review).toHaveBeenCalledTimes(1);
    expect(report.review).toEqual({
      ...defaultReviewSettings,
      verify: false,
      minSeverity: "major"
    });
  });
});
