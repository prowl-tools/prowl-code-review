import { describe, expect, it } from "vitest";
import {
  dedupeFindings,
  rankFindings,
  filterBySeverity,
  judgeFindings
} from "../src/review/judge.js";
import type { Finding } from "../src/review/findings.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "a.ts",
    line: 1,
    severity: "minor",
    category: "correctness",
    title: "t",
    body: "b",
    confidence: 0.5,
    ...overrides
  };
}

describe("dedupeFindings", () => {
  it("collapses same file+line+category, keeping the more severe", () => {
    const result = dedupeFindings([
      finding({ severity: "minor", title: "weak" }),
      finding({ severity: "critical", title: "strong" })
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("strong");
  });

  it("breaks severity ties by confidence", () => {
    const result = dedupeFindings([
      finding({ severity: "major", confidence: 0.4, title: "low" }),
      finding({ severity: "major", confidence: 0.9, title: "high" })
    ]);
    expect(result[0].title).toBe("high");
  });

  it("keeps findings that differ by file, line, or category", () => {
    const result = dedupeFindings([
      finding({ file: "a.ts" }),
      finding({ file: "b.ts" }),
      finding({ line: 2 }),
      finding({ category: "security" })
    ]);
    expect(result).toHaveLength(4);
  });
});

describe("rankFindings", () => {
  it("orders by severity then confidence", () => {
    const ranked = rankFindings([
      finding({ severity: "minor" }),
      finding({ severity: "critical" }),
      finding({ severity: "major", confidence: 0.3 }),
      finding({ severity: "major", confidence: 0.8 })
    ]);
    expect(ranked.map((f) => f.severity)).toEqual(["critical", "major", "major", "minor"]);
    expect(ranked[1].confidence).toBe(0.8); // higher-confidence major first
  });
});

describe("filterBySeverity", () => {
  it("drops findings below the threshold", () => {
    const kept = filterBySeverity(
      [finding({ severity: "critical" }), finding({ severity: "minor" }), finding({ severity: "info" })],
      "major"
    );
    expect(kept.map((f) => f.severity)).toEqual(["critical"]);
  });
});

describe("judgeFindings", () => {
  it("dedupes, thresholds, ranks, and reports counts", () => {
    const result = judgeFindings(
      [
        finding({ severity: "minor", title: "dup-weak" }),
        finding({ severity: "critical", title: "dup-strong" }), // same key as above → deduped
        finding({ file: "b.ts", severity: "info" }), // dropped by threshold
        finding({ file: "c.ts", severity: "major" })
      ],
      { minSeverity: "minor" }
    );
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.belowThreshold).toBe(1);
    expect(result.findings.map((f) => f.severity)).toEqual(["critical", "major"]);
  });
});
