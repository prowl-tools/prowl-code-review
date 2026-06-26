import { type Finding, isBlockingFinding } from "./findings.js";

/**
 * Suggested-fix validation (backlog #39).
 *
 * Committable ```suggestion``` blocks are one-click commits, so a wrong one can
 * break the build. We gate them two ways before they're rendered (in
 * `inline.ts`), without mutating the finding (so #12 fingerprints stay stable):
 *
 * 1. **Confidence** — only findings at/above {@link DEFAULT_SUGGESTION_MIN_CONFIDENCE}
 *    offer a committable suggestion. The proposed fix is still available to a
 *    coding agent via the "Resolve with an AI agent" prompt (#57); it just isn't
 *    a one-click commit when the reviewer isn't confident.
 * 2. **Structure** — a deterministic, no-execution sanity check that drops
 *    suggestions that are empty, are obvious truncation placeholders, or carry a
 *    leaked redaction marker. It is intentionally conservative: a valid GitHub
 *    suggestion may legitimately have unbalanced brackets (it replaces specific
 *    lines inside a larger block), so we never reject on delimiter balance.
 *
 * (Sandbox apply-and-typecheck/lint of the fix is a heavier, opt-in future
 * extension — it would execute untrusted fix code, which conflicts with the
 * no-execute-untrusted-checkout default; see #39 notes.)
 */

/** Findings at/above this confidence may offer a committable suggestion. Default 0.8. */
export const DEFAULT_SUGGESTION_MIN_CONFIDENCE = 0.8;

/** Outcome of validating a suggestion's structure. */
export interface SuggestionValidation {
  ok: boolean;
  /** Why the suggestion was rejected (for notes/telemetry); undefined when ok. */
  reason?: "empty" | "placeholder" | "redacted";
}

// Lines that are clearly a model leaving the real code out (truncation), rather
// than a committable fix. High-precision so real fixes aren't rejected.
const PLACEHOLDER_LINE_PATTERNS: RegExp[] = [
  /^\s*(?:\/\/|#|--|;)\s*\.{3,}\s*$/, // a comment that's only "..."
  /^\s*\/\*\s*\.{3,}\s*\*\/\s*$/, // /* ... */
  /^\s*\{?\s*\/\*\s*\.{3,}.*\*\/\s*\}?\s*$/ // {/* ... */}
];

const PLACEHOLDER_PHRASES =
  /(\.\.\.\s*)?(existing|unchanged|rest of(?: the)?)\s+(code|lines?|file|function|method|implementation)|your code here|insert\b[^\n]*\bhere|<\s*(?:your|insert|placeholder|code)\b[^>]*>|keep (?:existing|the rest)/i;

/**
 * Structurally validate a suggestion without executing anything. Rejects empty
 * suggestions, obvious truncation placeholders, and leaked redaction markers.
 */
export function validateSuggestion(suggestion: string | undefined): SuggestionValidation {
  const text = suggestion?.replace(/\r\n/g, "\n") ?? "";
  if (text.trim().length === 0) {
    return { ok: false, reason: "empty" };
  }
  // A redaction marker means the "fix" would commit a placeholder over a secret.
  if (/\[REDACTED:[^\]]*\]/.test(text)) {
    return { ok: false, reason: "redacted" };
  }
  const lines = text.split("\n");
  if (lines.some((line) => PLACEHOLDER_LINE_PATTERNS.some((re) => re.test(line)))) {
    return { ok: false, reason: "placeholder" };
  }
  if (PLACEHOLDER_PHRASES.test(text)) {
    return { ok: false, reason: "placeholder" };
  }
  return { ok: true };
}

/** True when a finding carries a non-empty suggestion. */
export function hasSuggestion(finding: Finding): boolean {
  return Boolean(finding.suggestion?.trim());
}

/**
 * Whether a finding's suggestion should render as a **committable** block:
 * it has one, clears the confidence floor, and passes structural validation.
 */
export function shouldCommitSuggestion(finding: Finding, minConfidence = DEFAULT_SUGGESTION_MIN_CONFIDENCE): boolean {
  if (!hasSuggestion(finding)) {
    return false;
  }
  return finding.confidence >= minConfidence && validateSuggestion(finding.suggestion).ok;
}

/** Counts of withheld committable suggestions, for a review note (#5: no silent drop). */
export interface SuggestionGatingSummary {
  /** Findings with a suggestion withheld because confidence was below the floor. */
  withheldLowConfidence: number;
  /** Findings with a suggestion withheld because it failed structural validation. */
  withheldInvalid: number;
}

/**
 * Summarize how many committable suggestions were withheld among the findings
 * that would actually render one (blocking findings, #58). Low-confidence is
 * attributed first so a finding isn't double-counted.
 */
export function summarizeSuggestionGating(
  findings: Finding[],
  minConfidence = DEFAULT_SUGGESTION_MIN_CONFIDENCE
): SuggestionGatingSummary {
  let withheldLowConfidence = 0;
  let withheldInvalid = 0;
  for (const finding of findings) {
    if (!isBlockingFinding(finding) || !hasSuggestion(finding)) {
      continue;
    }
    if (finding.confidence < minConfidence) {
      withheldLowConfidence += 1;
    } else if (!validateSuggestion(finding.suggestion).ok) {
      withheldInvalid += 1;
    }
  }
  return { withheldLowConfidence, withheldInvalid };
}
