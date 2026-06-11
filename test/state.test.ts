import { describe, expect, it } from "vitest";
import {
  findingFingerprint,
  serializeState,
  parseState,
  embedState,
  REVIEW_STATE_VERSION,
  type ReviewState
} from "../src/review/state.js";
import type { Finding } from "../src/review/findings.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: 10,
    severity: "major",
    category: "correctness",
    title: "Off-by-one in loop bound",
    body: "b",
    confidence: 0.8,
    ...over
  };
}

describe("findingFingerprint", () => {
  it("is stable across line drift (line-independent)", () => {
    expect(findingFingerprint(finding({ line: 10 }))).toBe(findingFingerprint(finding({ line: 25 })));
  });

  it("normalizes path separators, title case, and whitespace", () => {
    const a = findingFingerprint(finding({ file: "src\\a.ts", title: "Off-by-one   in loop bound" }));
    const b = findingFingerprint(finding({ file: "./src/a.ts", title: "off-by-one in loop bound" }));
    expect(a).toBe(b);
  });

  it("differs by file, category, title, body, and suggestion", () => {
    const base = findingFingerprint(finding());
    expect(findingFingerprint(finding({ file: "src/b.ts" }))).not.toBe(base);
    expect(findingFingerprint(finding({ category: "security" }))).not.toBe(base);
    expect(findingFingerprint(finding({ title: "Something else" }))).not.toBe(base);
    expect(findingFingerprint(finding({ body: "different explanation" }))).not.toBe(base);
    expect(findingFingerprint(finding({ suggestion: "return value;" }))).not.toBe(base);
  });

  it("normalizes finding body whitespace and case", () => {
    const a = findingFingerprint(finding({ body: "Missing   await\nbefore call" }));
    const b = findingFingerprint(finding({ body: "missing await before CALL" }));
    expect(a).toBe(b);
  });
});

describe("serializeState / parseState round-trip", () => {
  const state: ReviewState = {
    v: REVIEW_STATE_VERSION,
    lastReviewedSha: "abc123",
    postedFindings: ["aaaa", "bbbb"]
  };

  it("round-trips through the hidden marker", () => {
    expect(parseState(serializeState(state))).toEqual(state);
  });

  it("finds the marker embedded in a larger body", () => {
    const body = `## prowl-review\n\nsome summary\n\n${serializeState(state)}`;
    expect(parseState(body)).toEqual(state);
  });

  it("returns null for missing/empty/markerless bodies", () => {
    expect(parseState(null)).toBeNull();
    expect(parseState("")).toBeNull();
    expect(parseState("just a normal comment")).toBeNull();
  });

  it("returns null for a malformed or schema-invalid marker (graceful fallback)", () => {
    expect(parseState("<!-- prowl-review:state {not json} -->")).toBeNull();
    expect(parseState('<!-- prowl-review:state {"v":"x"} -->')).toBeNull();
    expect(parseState('<!-- prowl-review:state {"v":2,"postedFindings":[]} -->')).toBeNull();
  });

  it("defaults postedFindings to an empty array when omitted", () => {
    const parsed = parseState('<!-- prowl-review:state {"v":1} -->');
    expect(parsed).toEqual({ v: 1, postedFindings: [] });
  });
});

describe("embedState", () => {
  it("appends the marker at the end of the body", () => {
    const out = embedState("## prowl-review\n\nbody", { v: 1, postedFindings: ["x"] });
    expect(out).toContain("## prowl-review");
    expect(parseState(out)).toEqual({ v: 1, postedFindings: ["x"] });
  });

  it("replaces a prior marker rather than stacking duplicates", () => {
    const first = embedState("body", { v: 1, postedFindings: ["x"] });
    const second = embedState(first, { v: 1, lastReviewedSha: "sha2", postedFindings: ["x", "y"] });
    // Only one marker remains, with the latest state.
    expect(second.match(/prowl-review:state/g)).toHaveLength(1);
    expect(parseState(second)).toEqual({ v: 1, lastReviewedSha: "sha2", postedFindings: ["x", "y"] });
  });
});
