import { describe, expect, it } from "vitest";
import { parseFindings, findingKey, FindingSchema } from "../src/review/findings.js";

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

  it("drops invalid entries but keeps valid ones", () => {
    const findings = parseFindings(JSON.stringify([VALID, { file: "x" }, { ...VALID, severity: "bogus" }]));
    expect(findings).toHaveLength(1);
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
