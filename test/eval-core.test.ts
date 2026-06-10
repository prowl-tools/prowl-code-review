import { describe, expect, it } from "vitest";
import { matchesBug, scoreCase, erroredCase } from "../src/eval/match.js";
import { aggregate, precision, recall, f1Score } from "../src/eval/metrics.js";
import { BenchmarkCaseSchema, type ExpectedBug } from "../src/eval/types.js";
import type { Finding } from "../src/review/findings.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "a.ts",
    line: 10,
    severity: "major",
    category: "correctness",
    title: "t",
    body: "b",
    confidence: 0.9,
    ...over
  };
}

function bug(over: Partial<ExpectedBug> = {}): ExpectedBug {
  return { file: "a.ts", line: 10, note: "seeded", ...over };
}

describe("matchesBug", () => {
  it("matches on same file within the default ±3 line window", () => {
    expect(matchesBug(finding({ line: 13 }), bug({ line: 10 }))).toBe(true);
    expect(matchesBug(finding({ line: 14 }), bug({ line: 10 }))).toBe(false);
  });

  it("requires the same file", () => {
    expect(matchesBug(finding({ file: "b.ts" }), bug({ file: "a.ts" }))).toBe(false);
  });

  it("normalises path separators and leading ./", () => {
    expect(matchesBug(finding({ file: "src\\a.ts" }), bug({ file: "./src/a.ts" }))).toBe(true);
  });

  it("treats overlapping multi-line ranges as a match", () => {
    const f = finding({ line: 20, endLine: 30 });
    expect(matchesBug(f, bug({ line: 28, endLine: 35 }))).toBe(true);
    expect(matchesBug(f, bug({ line: 40, endLine: 45 }))).toBe(false);
  });

  it("never matches an unlocated finding", () => {
    expect(matchesBug(finding({ line: undefined }), bug())).toBe(false);
  });

  it("honours requireCategory only when the bug declares one", () => {
    const f = finding({ category: "security" });
    expect(matchesBug(f, bug({ category: "correctness" }), { requireCategory: true })).toBe(false);
    expect(matchesBug(f, bug({ category: "security" }), { requireCategory: true })).toBe(true);
    // No category on the bug → category is ignored even when required.
    expect(matchesBug(f, bug(), { requireCategory: true })).toBe(true);
  });

  it("respects a custom line window", () => {
    expect(matchesBug(finding({ line: 20 }), bug({ line: 10 }), { lineWindow: 10 })).toBe(true);
  });
});

describe("scoreCase", () => {
  it("scores a bug case: covered bugs, false negatives, false positives", () => {
    const findings = [
      finding({ file: "a.ts", line: 10 }), // hits bug 1
      finding({ file: "a.ts", line: 11 }), // also hits bug 1 (redundant, not an FP)
      finding({ file: "z.ts", line: 99 }) // hits nothing → FP
    ];
    const expected = [bug({ file: "a.ts", line: 10 }), bug({ file: "b.ts", line: 50 })];
    const result = scoreCase("c1", "bug", findings, expected);

    expect(result.expectedBugs).toBe(2);
    expect(result.coveredBugs).toBe(1); // bug 1 covered, bug 2 missed
    expect(result.falseNegatives).toBe(1);
    expect(result.findings).toBe(3);
    expect(result.matchedFindings).toBe(2); // the two on a.ts:10/11
    expect(result.falsePositives).toBe(1); // z.ts:99
  });

  it("counts every finding on a clean case as a false positive", () => {
    const result = scoreCase("c2", "clean", [finding(), finding({ line: 50 })], []);
    expect(result.coveredBugs).toBe(0);
    expect(result.falseNegatives).toBe(0);
    expect(result.falsePositives).toBe(2);
    expect(result.matchedFindings).toBe(0);
  });

  it("a perfect clean case has zero false positives", () => {
    const result = scoreCase("c3", "clean", [], []);
    expect(result.falsePositives).toBe(0);
    expect(result.findings).toBe(0);
  });
});

describe("metric helpers", () => {
  it("precision/recall/f1 edge cases", () => {
    expect(precision(0, 0)).toBe(1); // no findings → vacuously precise
    expect(precision(3, 4)).toBeCloseTo(0.75);
    expect(recall(0, 0)).toBe(1); // no bugs → vacuously complete
    expect(recall(2, 4)).toBe(0.5);
    expect(f1Score(0, 0.5)).toBe(0);
    expect(f1Score(0.75, 0.5)).toBeCloseTo(0.6);
  });
});

describe("aggregate", () => {
  it("combines bug + clean cases and excludes errored ones", () => {
    const results = [
      scoreCase("bug1", "bug", [finding({ line: 10 })], [bug({ line: 10 }), bug({ line: 100 })]),
      scoreCase("clean1", "clean", [finding({ file: "x.ts", line: 5 })], []),
      erroredCase("bug2", "bug", "provider down")
    ];
    const metrics = aggregate(results);

    // bug1: covered 1/2, matched 1/1 finding. clean1: 1 finding, all FP.
    expect(metrics.expectedBugs).toBe(2);
    expect(metrics.coveredBugs).toBe(1);
    expect(metrics.recall).toBe(0.5);
    expect(metrics.totalFindings).toBe(2); // 1 + 1 (errored excluded)
    expect(metrics.matchedFindings).toBe(1);
    expect(metrics.precision).toBe(0.5);
    expect(metrics.f1).toBeCloseTo(0.5);
    expect(metrics.cleanCases).toBe(1);
    expect(metrics.bugCases).toBe(1); // errored bug excluded
    expect(metrics.cleanFalseAlarmRate).toBe(1); // 1 false finding / 1 clean case
  });

  it("reports perfect metrics for an empty benchmark", () => {
    const metrics = aggregate([]);
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
    expect(metrics.f1).toBe(1);
    expect(metrics.cleanFalseAlarmRate).toBe(0);
  });
});

describe("BenchmarkCaseSchema", () => {
  const base = {
    id: "x",
    description: "d",
    kind: "bug" as const,
    diff: "diff --git a/a.ts b/a.ts\n+bad();"
  };

  it("accepts a valid bug case with expected defects", () => {
    const parsed = BenchmarkCaseSchema.parse({
      ...base,
      expected: [{ file: "a.ts", line: 1, note: "boom" }]
    });
    expect(parsed.expected).toHaveLength(1);
  });

  it("rejects a bug case with no expected defects", () => {
    expect(() => BenchmarkCaseSchema.parse({ ...base, expected: [] })).toThrow(/at least one expected/);
  });

  it("rejects a clean case that lists expected defects", () => {
    expect(() =>
      BenchmarkCaseSchema.parse({
        ...base,
        kind: "clean",
        expected: [{ file: "a.ts", line: 1, note: "x" }]
      })
    ).toThrow(/must not list expected/);
  });

  it("defaults expected to an empty array for clean cases", () => {
    const parsed = BenchmarkCaseSchema.parse({ ...base, kind: "clean" });
    expect(parsed.expected).toEqual([]);
  });
});
