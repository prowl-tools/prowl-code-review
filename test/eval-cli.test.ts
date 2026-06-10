import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveBenchDir,
  parseLineWindow,
  parseThreshold,
  evaluateThresholds,
  evaluateGate
} from "../src/cli/commands/eval.js";
import { renderReportMarkdown, renderReportJson } from "../src/eval/report.js";
import type { EvalMetrics, EvalReport } from "../src/eval/types.js";

const ORIGINAL_ENV = process.env;
beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});
afterEach(() => {
  process.env = ORIGINAL_ENV;
});

function metrics(over: Partial<EvalMetrics> = {}): EvalMetrics {
  return {
    coveredBugs: 3,
    expectedBugs: 4,
    matchedFindings: 3,
    totalFindings: 4,
    precision: 0.75,
    recall: 0.75,
    f1: 0.75,
    cleanFalseAlarmRate: 0.5,
    cleanCases: 2,
    bugCases: 4,
    ...over
  };
}

describe("eval command helpers", () => {
  it("resolves the bench dir, defaulting to ./bench and honouring absolute paths", () => {
    expect(resolveBenchDir("/abs/bench")).toBe("/abs/bench");
    expect(resolveBenchDir(undefined).endsWith("/bench")).toBe(true);
    expect(resolveBenchDir("  ").endsWith("/bench")).toBe(true);
  });

  it("parses and validates the line window", () => {
    expect(parseLineWindow(undefined)).toBeUndefined();
    expect(parseLineWindow("0")).toBe(0);
    expect(parseLineWindow("5")).toBe(5);
    expect(() => parseLineWindow("-1")).toThrow(/Invalid --line-window/);
    expect(() => parseLineWindow("1.5")).toThrow(/Invalid --line-window/);
  });

  it("parses and validates 0–1 thresholds", () => {
    expect(parseThreshold(undefined, "--min-f1")).toBeUndefined();
    expect(parseThreshold("0.8", "--min-f1")).toBe(0.8);
    expect(() => parseThreshold("1.5", "--min-f1")).toThrow(/Invalid --min-f1/);
    expect(() => parseThreshold("nope", "--min-f1")).toThrow(/Invalid --min-f1/);
  });

  it("reports threshold failures and passes when met", () => {
    expect(evaluateThresholds(metrics(), {})).toEqual([]);
    expect(evaluateThresholds(metrics(), { precision: 0.7, recall: 0.7, f1: 0.7 })).toEqual([]);

    const failures = evaluateThresholds(metrics({ precision: 0.5, recall: 0.6, f1: 0.55 }), {
      precision: 0.8,
      recall: 0.8,
      f1: 0.8
    });
    expect(failures).toHaveLength(3);
    expect(failures[0]).toMatch(/precision/);
    expect(failures[1]).toMatch(/recall/);
    expect(failures[2]).toMatch(/F1/);
  });

  it("fails the gate when benchmark cases errored", () => {
    const report = { metrics: metrics({ precision: 1, recall: 1, f1: 1 }), errored: 2 };
    expect(evaluateGate(report, { precision: 0.9, recall: 0.9, f1: 0.9 })).toEqual([
      "2 benchmark cases errored"
    ]);
  });

  it("passes the gate when thresholds are met and no cases errored", () => {
    const report = { metrics: metrics({ precision: 0.9, recall: 0.85, f1: 0.87 }), errored: 0 };
    expect(evaluateGate(report, { precision: 0.8, recall: 0.8, f1: 0.8 })).toEqual([]);
  });

  it("reports threshold-only gate failures", () => {
    const report = { metrics: metrics({ precision: 0.5, recall: 0.6, f1: 0.55 }), errored: 0 };
    expect(evaluateGate(report, { precision: 0.8, recall: 0.8, f1: 0.8 })).toEqual([
      "precision 50.0% < min 80.0%",
      "recall 60.0% < min 80.0%",
      "F1 55.0% < min 80.0%"
    ]);
  });

  it("reports threshold and errored-case gate failures together", () => {
    const report = { metrics: metrics({ precision: 0.5, recall: 0.85, f1: 0.65 }), errored: 1 };
    expect(evaluateGate(report, { precision: 0.8, recall: 0.8, f1: 0.8 })).toEqual([
      "precision 50.0% < min 80.0%",
      "F1 65.0% < min 80.0%",
      "1 benchmark case errored"
    ]);
  });
});

describe("report rendering", () => {
  const report: EvalReport = {
    provider: "anthropic",
    model: "claude-x",
    promptFingerprint: "abc123def456",
    match: { lineWindow: 3, requireCategory: false },
    metrics: metrics({ precision: 0.75, recall: 0.6, f1: 0.667 }),
    cases: [
      {
        id: "bug-hit",
        kind: "bug",
        expectedBugs: 1,
        coveredBugs: 1,
        falseNegatives: 0,
        findings: 1,
        matchedFindings: 1,
        falsePositives: 0,
        errored: false
      },
      {
        id: "clean-noisy",
        kind: "clean",
        expectedBugs: 0,
        coveredBugs: 0,
        falseNegatives: 0,
        findings: 2,
        matchedFindings: 0,
        falsePositives: 2,
        errored: false
      },
      {
        id: "broke",
        kind: "bug",
        expectedBugs: 0,
        coveredBugs: 0,
        falseNegatives: 0,
        findings: 0,
        matchedFindings: 0,
        falsePositives: 0,
        errored: true,
        error: "provider down"
      }
    ],
    errored: 1
  };

  it("renders a markdown summary with metrics, fingerprint, and per-case rows", () => {
    const md = renderReportMarkdown(report);
    expect(md).toContain("anthropic / claude-x");
    expect(md).toContain("`abc123def456`");
    expect(md).toContain("Precision | 75.0%");
    expect(md).toContain("Recall | 60.0%");
    expect(md).toContain("| bug-hit | bug |");
    expect(md).toContain("clean-noisy");
    expect(md).toContain("⚠️ errored");
    expect(md).toContain("excluded from metrics");
  });

  it("round-trips JSON", () => {
    const parsed = JSON.parse(renderReportJson(report));
    expect(parsed.promptFingerprint).toBe("abc123def456");
    expect(parsed.cases).toHaveLength(3);
  });
});
