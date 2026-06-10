import { describe, expect, it } from "vitest";
import {
  dedupeFindings,
  rankFindings,
  filterBySeverity,
  filterByConfidence,
  judgeFindings,
  DEFAULT_MAX_FINDINGS
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

describe("filterByConfidence", () => {
  it("drops non-critical findings below the floor but always keeps criticals", () => {
    const kept = filterByConfidence(
      [
        finding({ severity: "major", confidence: 0.3, title: "low-major" }),
        finding({ severity: "major", confidence: 0.8, title: "high-major" }),
        finding({ severity: "critical", confidence: 0.1, title: "unsure-critical" })
      ],
      0.5
    );
    expect(kept.map((f) => f.title)).toEqual(["high-major", "unsure-critical"]);
  });
});

describe("judgeFindings high-signal defaults (#55)", () => {
  it("suppresses trivial/info and low-confidence findings by default", () => {
    const result = judgeFindings([
      finding({ file: "a.ts", severity: "trivial", confidence: 0.9 }), // dropped: severity
      finding({ file: "b.ts", severity: "minor", confidence: 0.3 }), // dropped: confidence
      finding({ file: "c.ts", severity: "minor", confidence: 0.8 }), // kept
      finding({ file: "d.ts", severity: "critical", confidence: 0.2 }) // kept (critical exempt)
    ]);
    expect(result.belowThreshold).toBe(1);
    expect(result.belowConfidence).toBe(1);
    expect(result.findings.map((f) => f.file)).toEqual(["d.ts", "c.ts"]);
  });

  it("preserves high-confidence duplicates before choosing a preferred finding", () => {
    const result = judgeFindings(
      [
        finding({ severity: "major", confidence: 0.4, title: "low-confidence-major" }),
        finding({ severity: "minor", confidence: 0.9, title: "high-confidence-minor" })
      ],
      { minSeverity: "minor", minConfidence: 0.5 }
    );

    expect(result.belowConfidence).toBe(1);
    expect(result.duplicatesRemoved).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("high-confidence-minor");
  });

  it("caps the number of findings and reports the overflow", () => {
    const many = Array.from({ length: DEFAULT_MAX_FINDINGS + 5 }, (_, i) =>
      finding({ file: `f${i}.ts`, severity: "major", confidence: 0.9 })
    );
    const result = judgeFindings(many);
    expect(result.findings).toHaveLength(DEFAULT_MAX_FINDINGS);
    expect(result.capped).toBe(5);
  });

  it("allows maxFindings to suppress all ranked findings", () => {
    const findings = [
      finding({ file: "a.ts", severity: "major", confidence: 0.9 }),
      finding({ file: "b.ts", severity: "major", confidence: 0.9 })
    ];
    const result = judgeFindings(findings, { maxFindings: 0 });

    expect(result.findings).toEqual([]);
    expect(result.capped).toBe(2);
  });

  it("clamps negative maxFindings before slicing", () => {
    const findings = [
      finding({ file: "a.ts", severity: "major", confidence: 0.9 }),
      finding({ file: "b.ts", severity: "major", confidence: 0.9 }),
      finding({ file: "c.ts", severity: "major", confidence: 0.9 })
    ];
    const result = judgeFindings(findings, { maxFindings: -5 });

    expect(result.findings).toEqual([]);
    expect(result.capped).toBe(3);
  });

  it("returns all findings when the cap is higher than the ranked count", () => {
    const findings = [
      finding({ file: "a.ts", severity: "major", confidence: 0.9 }),
      finding({ file: "b.ts", severity: "minor", confidence: 0.9 })
    ];
    const result = judgeFindings(findings, { maxFindings: 5 });

    expect(result.findings).toHaveLength(2);
    expect(result.capped).toBe(0);
  });

  it("applies severity and confidence filters before capping", () => {
    const result = judgeFindings(
      [
        finding({ file: "a.ts", severity: "major", confidence: 0.9 }),
        finding({ file: "b.ts", severity: "minor", confidence: 0.9 }),
        finding({ file: "c.ts", severity: "major", confidence: 0.2 }),
        finding({ file: "d.ts", severity: "info", confidence: 0.9 })
      ],
      { maxFindings: 1 }
    );

    expect(result.belowThreshold).toBe(1);
    expect(result.belowConfidence).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.capped).toBe(1);
    expect(result.findings[0].file).toBe("a.ts");
  });
});
