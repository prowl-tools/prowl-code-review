/**
 * Human reply-intent classification for finding threads (backlog #22).
 *
 * When a developer replies to one of prowl-review's inline finding threads, the
 * reviewer should honor that reply instead of re-nagging on the next push:
 *  - **won't-fix / acknowledged** → the human has decided; resolve the thread and
 *    stop re-surfacing the finding.
 *  - **disagree** → the human disputes the finding; don't auto-resolve it and
 *    don't blindly re-raise it — withhold it pending re-justification.
 *
 * Pure and conservative: ambiguous replies classify as `other` (no action), so
 * the reviewer only changes behavior on a clear signal. Untrusted PR text is only
 * ever matched against these patterns, never executed or echoed unescaped.
 */

/** Classified intent of a human reply on a finding thread. */
export type ReplyIntent = "wont-fix" | "acknowledged" | "disagree" | "other";

/** The human disputes the finding — keep the thread open, don't blindly re-raise. */
const DISAGREE_PATTERNS: RegExp[] = [
  /\bdisagree\b/,
  /\bfalse[ -]?positive\b/,
  /\bnot a (real )?(bug|issue|problem|concern)\b/,
  /\b(this|that)('?s| is) (wrong|incorrect|not right|not correct)\b/,
  /\bi (don'?t|do not) (agree|think)\b/,
  /\b(this|that) is incorrect\b/
];

/** The human declines to fix — a decision; resolve the thread. */
const WONT_FIX_PATTERNS: RegExp[] = [
  /\bwon'?t fix\b/,
  /\bwontfix\b/,
  /\bnot (going to|gonna) fix\b/,
  /\bas[ -]designed\b/,
  /\bby design\b/,
  /\bworking as intended\b/,
  /\bintentional\b/
];

/** The human accepts the finding (or already fixed it) — resolve the thread. */
const ACKNOWLEDGED_PATTERNS: RegExp[] = [
  /\backnowledg/,
  /\bnoted\b/,
  /\bgot it\b/,
  /\bmakes sense\b/,
  /\bgood (catch|point)\b/,
  /\b(fixed|resolved|addressed|done)\b/,
  /\bwill (fix|address|handle|do|update)\b/
];

/** Mentions that a fix/acknowledgement has not happened yet — do not resolve. */
const NEGATED_ACKNOWLEDGEMENT_PATTERNS: RegExp[] = [
  /\b(?:not|isn'?t|aren'?t|wasn'?t|weren'?t|still not)\s+(?:fixed|resolved|addressed|done)\b/,
  /\b(?:hasn'?t|haven'?t|hadn'?t)\s+been\s+(?:fixed|resolved|addressed|done)\b/,
  /\b(?:fixed|resolved|addressed|done)\s+(?:not|yet|nope)\b/,
  /\bstill\s+(?:unfixed|unresolved|unaddressed)\b/
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Classify a human reply body into a {@link ReplyIntent}. Precedence is
 * disagree → won't-fix → acknowledged → other: a dispute is honored even when
 * the same reply also reads as a decision, since it needs the most careful
 * (non-destructive) handling.
 */
export function classifyReplyIntent(body: string | null | undefined): ReplyIntent {
  if (typeof body !== "string") {
    return "other";
  }
  const text = body.toLowerCase();
  if (matchesAny(text, DISAGREE_PATTERNS)) {
    return "disagree";
  }
  if (matchesAny(text, WONT_FIX_PATTERNS)) {
    return "wont-fix";
  }
  if (matchesAny(text, NEGATED_ACKNOWLEDGEMENT_PATTERNS)) {
    return "other";
  }
  if (matchesAny(text, ACKNOWLEDGED_PATTERNS)) {
    return "acknowledged";
  }
  return "other";
}

/** True when the intent means the human has settled the thread (resolve + stop nagging). */
export function isResolvingIntent(intent: ReplyIntent): boolean {
  return intent === "wont-fix" || intent === "acknowledged";
}

/** True when the intent means the finding is disputed (keep open, withhold re-raise). */
export function isDisputingIntent(intent: ReplyIntent): boolean {
  return intent === "disagree";
}
