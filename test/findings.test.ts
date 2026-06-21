import { describe, expect, it } from "vitest";
import {
  parseFindings,
  parseFindingsResult,
  findingKey,
  FindingSchema,
  isBlockingFinding
} from "../src/review/findings.js";
import type { Finding, Severity } from "../src/review/findings.js";

const VALID = {
  file: "src/a.ts",
  line: 5,
  severity: "major",
  category: "correctness",
  title: "Bug",
  body: "Explanation"
};

describe("parseFindings", () => {
  it("parses a plain JSON array", () => {
    const findings = parseFindings(JSON.stringify([VALID]));
    expect(findings).toHaveLength(1);
    expect(findings[0].confidence).toBe(0.5); // default applied
  });

  it("strips markdown code fences", () => {
    const findings = parseFindings("```json\n" + JSON.stringify([VALID]) + "\n```");
    expect(findings).toHaveLength(1);
  });

  it("ignores prose around the JSON array", () => {
    const findings = parseFindings(`Here are my findings:\n${JSON.stringify([VALID])}\nThanks!`);
    expect(findings).toHaveLength(1);
  });

  it("handles brackets inside finding string fields", () => {
    const findings = parseFindings(
      `${JSON.stringify([{ ...VALID, body: "Array-like text [value] in the body" }])}\nTrailing prose ] ignored.`
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].body).toBe("Array-like text [value] in the body");
  });

  it("skips bracketed prose before the first valid findings array", () => {
    const findings = parseFindings(`Summary [not JSON]\n${JSON.stringify([VALID])}`);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ title: "Bug" });
  });

  it("skips schema-invalid arrays before the first valid findings array", () => {
    const findings = parseFindings(`Reviewed files: ${JSON.stringify(["src/a.ts"])}\n${JSON.stringify([VALID])}`);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ title: "Bug" });
  });

  it("drops invalid entries but keeps valid ones", () => {
    const findings = parseFindings(JSON.stringify([VALID, { file: "x" }, { ...VALID, severity: "bogus" }]));
    expect(findings).toHaveLength(1);
  });

  it("strips model-supplied ensemble provenance metadata", () => {
    const findings = parseFindings(JSON.stringify([{ ...VALID, sources: ["anthropic", "openai"] }]));

    expect(findings).toHaveLength(1);
    expect(findings[0].sources).toBeUndefined();
  });

  it("returns [] for non-array or unparseable output", () => {
    expect(parseFindings("no json here")).toEqual([]);
    expect(parseFindings('{"file":"a"}')).toEqual([]);
    expect(parseFindings("[not valid json")).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(parseFindings("[]")).toEqual([]);
  });
});

describe("parseFindingsResult (#7)", () => {
  it("reports ok with findings for a valid array", () => {
    const result = parseFindingsResult(JSON.stringify([VALID]));
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.invalid).toBe(0);
  });

  it("treats an explicit empty array as a valid 'no findings' result (not a retry)", () => {
    expect(parseFindingsResult("[]")).toEqual({ findings: [], ok: true, invalid: 0 });
    expect(parseFindingsResult("```json\n[]\n```")).toEqual({ findings: [], ok: true, invalid: 0 });
    expect(parseFindingsResult("  [ ]  ")).toEqual({ findings: [], ok: true, invalid: 0 });
  });

  it("counts schema-invalid entries while still reporting ok", () => {
    const result = parseFindingsResult(JSON.stringify([VALID, { file: "x" }, { ...VALID, severity: "bogus" }]));
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.invalid).toBe(2);
  });

  it("reports not-ok for unparseable output (the retry trigger)", () => {
    expect(parseFindingsResult("no json here")).toEqual({ findings: [], ok: false, invalid: 0 });
    expect(parseFindingsResult('{"file":"a"}')).toEqual({ findings: [], ok: false, invalid: 0 });
    expect(parseFindingsResult("[not valid json")).toEqual({ findings: [], ok: false, invalid: 0 });
  });
});

describe("FindingSchema", () => {
  it("rejects out-of-range confidence", () => {
    expect(FindingSchema.safeParse({ ...VALID, confidence: 2 }).success).toBe(false);
  });
});

describe("findingKey", () => {
  it("is stable and case-insensitive on category", () => {
    const a = FindingSchema.parse({ ...VALID, category: "Security" });
    const b = FindingSchema.parse({ ...VALID, category: "security" });
    expect(findingKey(a)).toBe(findingKey(b));
  });

  it("treats a missing line as 0", () => {
    const noLine = FindingSchema.parse({ ...VALID, line: undefined });
    expect(findingKey(noLine)).toContain("|0|");
  });
});

describe("isBlockingFinding", () => {
  const cases: Array<[Severity, boolean]> = [
    ["critical", true],
    ["major", true],
    ["minor", false],
    ["trivial", false],
    ["info", false]
  ];

  it.each(cases)("classifies %s findings as blocking=%s", (severity, expected) => {
    const finding = FindingSchema.parse({ ...VALID, severity }) as Finding;
    expect(isBlockingFinding(finding)).toBe(expected);
  });
});
