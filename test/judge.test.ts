import { describe, expect, it } from "vitest";
import {
  dedupeFindings,
  rankFindings,
  filterBySeverity,
  filterByConfidence,
  judgeFindings,
  judgeEnsembleFindings,
  consensusConfidence,
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

  it("dedupes linter grounding against specialist rediscoveries on the same line", () => {
    const result = dedupeFindings([
      finding({ category: "lint", severity: "minor", title: "no-debugger", body: "Unexpected debugger statement (no-debugger)", confidence: 0.9 }),
      finding({ category: "correctness", severity: "major", title: "debug statement left in code", body: "Unexpected debugger statement", confidence: 0.8 })
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("debug statement left in code");
  });

  it("keeps unrelated specialist findings on linted lines", () => {
    const result = dedupeFindings([
      finding({ category: "lint", severity: "minor", title: "no-console", body: "Unexpected console statement (no-console)", confidence: 0.9 }),
      finding({ category: "security", severity: "major", title: "leaked token", body: "A token is exposed in the response.", confidence: 0.8 })
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.title)).toEqual(["no-console", "leaked token"]);
  });

  it("keeps distinct lint findings on the same line", () => {
    const result = dedupeFindings([
      finding({ category: "lint", severity: "minor", title: "no-console", body: "Unexpected console statement (no-console)", confidence: 0.9 }),
      finding({ category: "lint", severity: "minor", title: "no-debugger", body: "Unexpected debugger statement (no-debugger)", confidence: 0.9 })
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.title)).toEqual(["no-console", "no-debugger"]);
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

  it("breaks complete ranking ties by stable finding key", () => {
    const ranked = rankFindings([
      finding({ line: 3, title: "later" }),
      finding({ line: 2, title: "earlier" })
    ]);

    expect(ranked.map((f) => f.title)).toEqual(["earlier", "later"]);
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

  it("treats negative infinity maxFindings as zero", () => {
    const findings = [
      finding({ file: "a.ts", severity: "major", confidence: 0.9 }),
      finding({ file: "b.ts", severity: "major", confidence: 0.9 })
    ];
    const result = judgeFindings(findings, { maxFindings: -Infinity });

    expect(result.findings).toEqual([]);
    expect(result.capped).toBe(2);
  });

  it("treats infinity maxFindings as all ranked findings", () => {
    const findings = [
      finding({ file: "a.ts", severity: "major", confidence: 0.9 }),
      finding({ file: "b.ts", severity: "major", confidence: 0.9 })
    ];
    const result = judgeFindings(findings, { maxFindings: Infinity });

    expect(result.findings).toHaveLength(2);
    expect(result.capped).toBe(0);
  });

  it("falls back to the default cap for NaN maxFindings", () => {
    const many = Array.from({ length: DEFAULT_MAX_FINDINGS + 5 }, (_, i) =>
      finding({ file: `f${i}.ts`, severity: "major", confidence: 0.9 })
    );
    const result = judgeFindings(many, { maxFindings: NaN });

    expect(result.findings).toHaveLength(DEFAULT_MAX_FINDINGS);
    expect(result.capped).toBe(5);
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

  it("selects the same capped findings regardless of input order", () => {
    const one = finding({ line: 3, title: "later", severity: "major", confidence: 0.9 });
    const two = finding({ line: 2, title: "earlier", severity: "major", confidence: 0.9 });

    const first = judgeFindings([one, two], { maxFindings: 1 });
    const second = judgeFindings([two, one], { maxFindings: 1 });

    expect(first.findings.map((f) => f.title)).toEqual(["earlier"]);
    expect(second.findings.map((f) => f.title)).toEqual(["earlier"]);
    expect(first.capped).toBe(1);
    expect(second.capped).toBe(1);
  });
});

describe("consensusConfidence (#53)", () => {
  it("leaves a single provider's confidence unchanged", () => {
    expect(consensusConfidence(0.5, 1)).toBe(0.5);
    expect(consensusConfidence(0.5, 0)).toBe(0.5);
  });

  it("boosts confidence per additional agreeing provider, capped at 1", () => {
    expect(consensusConfidence(0.5, 2)).toBeCloseTo(0.65);
    expect(consensusConfidence(0.5, 3)).toBeCloseTo(0.8);
    expect(consensusConfidence(0.95, 3)).toBe(1);
  });
});

describe("dedupeFindings with provenance (#53)", () => {
  it("unions sources and boosts confidence when providers agree", () => {
    const result = dedupeFindings(
      [
        finding({ title: "weak", confidence: 0.5, sources: ["anthropic"] }),
        finding({ title: "strong", severity: "major", confidence: 0.6, sources: ["openai"] })
      ],
      { mergeProvenance: true }
    );
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("strong"); // stronger representative kept
    expect(new Set(result[0].sources)).toEqual(new Set(["anthropic", "openai"]));
    expect(result[0].confidence).toBeCloseTo(0.75); // 0.6 + 0.15
  });

  it("does not merge provenance by default (single-provider path unchanged)", () => {
    const result = dedupeFindings([
      finding({ title: "a", confidence: 0.5, sources: ["anthropic"] }),
      finding({ title: "b", severity: "major", confidence: 0.6, sources: ["openai"] })
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.6); // no boost
  });
});

describe("judgeEnsembleFindings (#53)", () => {
  it("rescues an agreed finding that each provider scored just under the floor", () => {
    // Two providers each at 0.45 (below the 0.5 default floor); consensus lifts it.
    const result = judgeEnsembleFindings([
      finding({ severity: "major", confidence: 0.45, sources: ["anthropic"] }),
      finding({ severity: "major", confidence: 0.45, sources: ["openai"] })
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].confidence).toBeCloseTo(0.6);
    expect(new Set(result.findings[0].sources)).toEqual(new Set(["anthropic", "openai"]));
    expect(result.duplicatesRemoved).toBe(1);
  });

  it("still drops a lone low-confidence finding no one else raised", () => {
    const result = judgeEnsembleFindings([
      finding({ severity: "major", confidence: 0.3, sources: ["anthropic"] })
    ]);
    expect(result.findings).toHaveLength(0);
    expect(result.belowConfidence).toBe(1);
  });

  it("keeps single-provider findings but marks their provenance", () => {
    const result = judgeEnsembleFindings([
      finding({ severity: "major", confidence: 0.9, sources: ["anthropic"] })
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].sources).toEqual(["anthropic"]);
    expect(result.findings[0].confidence).toBe(0.9);
  });
});
