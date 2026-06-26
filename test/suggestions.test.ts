import { describe, expect, it } from "vitest";
import {
  validateSuggestion,
  shouldCommitSuggestion,
  summarizeSuggestionGating,
  DEFAULT_SUGGESTION_MIN_CONFIDENCE
} from "../src/review/suggestions.js";
import type { Finding } from "../src/review/findings.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: 5,
    severity: "major",
    category: "correctness",
    title: "t",
    body: "b",
    confidence: 0.9,
    ...over
  };
}

describe("validateSuggestion (#39)", () => {
  it("accepts a normal fix, including spread/rest (`...`) and unbalanced single-line edits", () => {
    expect(validateSuggestion("const x = 1;").ok).toBe(true);
    expect(validateSuggestion("fn(...args);").ok).toBe(true); // `...` is not a placeholder
    expect(validateSuggestion("  if (ready) {").ok).toBe(true); // valid single-line edit inside a block
  });

  it("rejects an empty suggestion", () => {
    expect(validateSuggestion("")).toEqual({ ok: false, reason: "empty" });
    expect(validateSuggestion("   \n  ")).toEqual({ ok: false, reason: "empty" });
    expect(validateSuggestion(undefined)).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects obvious truncation placeholders", () => {
    expect(validateSuggestion("// ...").reason).toBe("placeholder");
    expect(validateSuggestion("foo();\n# ...\nbar();").reason).toBe("placeholder");
    expect(validateSuggestion("const x = 1;\n// ... rest of the code\nreturn x;").reason).toBe("placeholder");
    expect(validateSuggestion("<your code here>").reason).toBe("placeholder");
    expect(validateSuggestion("doThing();\n// keep existing implementation").reason).toBe("placeholder");
  });

  it("rejects a suggestion carrying a leaked redaction marker", () => {
    expect(validateSuggestion('const key = "[REDACTED:llm-key]";').reason).toBe("redacted");
    expect(validateSuggestion('const key = "[REDACTED:[nested-value]]";').reason).toBe("redacted");
    expect(validateSuggestion('const key = "[REDACTED:unterminated";').reason).toBe("redacted");
  });
});

describe("shouldCommitSuggestion (#39)", () => {
  it("requires a suggestion, the confidence floor, and structural validity", () => {
    expect(shouldCommitSuggestion(finding({ suggestion: "const x = 1;", confidence: 0.9 }))).toBe(true);
    expect(shouldCommitSuggestion(finding({ confidence: 0.9 }))).toBe(false); // no suggestion
    expect(shouldCommitSuggestion(finding({ suggestion: "const x = 1;", confidence: 0.6 }))).toBe(false); // below floor
    expect(shouldCommitSuggestion(finding({ suggestion: "// ...", confidence: 0.99 }))).toBe(false); // invalid
  });

  it("honors a custom floor", () => {
    const f = finding({ suggestion: "const x = 1;", confidence: 0.6 });
    expect(shouldCommitSuggestion(f, 0.5)).toBe(true);
    expect(shouldCommitSuggestion(f, 0.8)).toBe(false);
  });

  it("defaults the floor to 0.8", () => {
    expect(DEFAULT_SUGGESTION_MIN_CONFIDENCE).toBe(0.8);
  });
});

describe("summarizeSuggestionGating (#39)", () => {
  it("counts withheld committable suggestions by reason, only for blocking findings", () => {
    const summary = summarizeSuggestionGating([
      finding({ suggestion: "const x = 1;", confidence: 0.9 }), // committable → not counted
      finding({ suggestion: "const y = 2;", confidence: 0.6 }), // low confidence
      finding({ suggestion: "// ...", confidence: 0.95 }), // invalid
      finding({ suggestion: "const z = 3;", confidence: 0.4, severity: "minor" }) // nitpick → never renders a suggestion
    ]);
    expect(summary).toEqual({ withheldLowConfidence: 1, withheldInvalid: 1 });
  });
});
