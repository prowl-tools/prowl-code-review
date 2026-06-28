import { createHash } from "node:crypto";
import { z } from "zod";
import type { Finding } from "./findings.js";
import { REVIEW_MARKER } from "./walkthrough.js";

/**
 * Review state persistence (backlog #12) — the store that makes the Action's
 * re-runs stateful without any external infrastructure.
 *
 * State is a small versioned JSON blob embedded in a hidden HTML-comment marker
 * inside prowl-review's own summary comment on the PR. On a re-run the publisher
 * (#22) finds the prior comment by {@link STATE_MARKER_PREFIX}, parses the state,
 * and uses it to update-not-duplicate (edit the summary in place, post only
 * net-new inline findings). No GitHub artifacts, no branches, no DB.
 *
 * This module is pure (serialize / parse / fingerprint); the GitHub read/write
 * side lives in `github/review.ts`.
 */

/** Bump when the persisted shape changes incompatibly. */
export const REVIEW_STATE_VERSION = 1;
export const GITHUB_COMMENT_BODY_LIMIT = 65_536;

const STATE_MARKER_PREFIX = "<!-- prowl-review:state ";
const STATE_MARKER_SUFFIX = " -->";
const SUMMARY_BODY_TRUNCATION_NOTICE =
  "[summary truncated to keep the GitHub comment within the body size limit]";

/** Matches the persisted state marker and captures its JSON payload. */
const STATE_MARKER_RE = /<!-- prowl-review:state ([\s\S]*?) -->/;

/** Persisted state marker schema embedded in prowl-review's summary comment. */
export const ReviewStateSchema = z.object({
  /** Schema version for forward-compatible parsing. */
  v: z.literal(REVIEW_STATE_VERSION),
  /** Head SHA the last review ran against (for incremental re-review, #23). */
  lastReviewedSha: z.string().min(1).optional(),
  /** Auto-review paused for this PR via `@prowl-review pause` (#26); resumed clears it. */
  paused: z.boolean().optional(),
  /** Fingerprints muted via `@prowl-review ignore` (#30); suppressed from future reviews of this PR. */
  ignoredFindings: z.array(z.string()).optional(),
  /** Per-PR review-setting overrides set via `@prowl-review configure` (#26); applied on later reviews. */
  configOverrides: z
    .object({
      minSeverity: z.enum(["critical", "major", "minor", "trivial", "info"]).optional(),
      maxFindings: z.number().int().positive().optional(),
      verify: z.boolean().optional()
    })
    .strict()
    .optional(),
  /** Fingerprints of findings already posted as inline comments (dedup across pushes). */
  postedFindings: z.array(z.string()).default([])
});

/** Parsed review state loaded from a prior prowl-review summary comment. */
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/** Summary body plus the fitted state actually persisted inside it. */
export interface EmbeddedState {
  /** Summary body with the refreshed state marker embedded. */
  body: string;
  /** State serialized into `body` after any size-based pruning. */
  state: ReviewState;
}

/** Normalize prose fields used by finding fingerprints without preserving cosmetic drift. */
function normalizeFingerprintText(value: string): string {
  return value.trim().toLowerCase().replace(/\r\n/g, "\n").replace(/\s+/g, " ");
}

/** Normalize optional suggested code used by finding fingerprints. */
function normalizeFingerprintSuggestion(value: string | undefined): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
}

/**
 * Stable fingerprint for an inline finding, used to avoid re-posting the same
 * comment on every push. Deliberately line-independent: a finding that drifts a
 * few lines as the PR evolves keeps the same fingerprint, so it isn't re-posted
 * as if it were new. Keyed on file + category + normalized title/body/suggestion.
 */
export function findingFingerprint(finding: Finding): string {
  const material = [
    finding.file.replace(/\\/g, "/").replace(/^\.\//, ""),
    normalizeFingerprintText(finding.category),
    normalizeFingerprintText(finding.title),
    normalizeFingerprintText(finding.body),
    normalizeFingerprintSuggestion(finding.suggestion)
  ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Render the hidden state marker comment for embedding in a summary body. */
export function serializeState(state: ReviewState): string {
  return `${STATE_MARKER_PREFIX}${JSON.stringify(state)}${STATE_MARKER_SUFFIX}`;
}

/** Keep as many recent posted fingerprints as will fit in the serialized state marker. */
export function fitStateWithinCommentLimit(state: ReviewState, maxLength: number): ReviewState {
  if (serializeState(state).length <= maxLength) {
    return state;
  }

  let base: ReviewState = { ...state, postedFindings: [] };
  if (serializeState(base).length > maxLength) {
    base = { v: state.v, postedFindings: [] };
  }

  let currentLength = serializeState(base).length;
  const kept: string[] = [];
  for (let index = state.postedFindings.length - 1; index >= 0; index -= 1) {
    const fingerprint = state.postedFindings[index];
    const nextLength = currentLength + JSON.stringify(fingerprint).length + (kept.length === 0 ? 0 : 1);
    if (nextLength > maxLength) {
      break;
    }
    kept.push(fingerprint);
    currentLength = nextLength;
  }

  kept.reverse();
  return { ...base, postedFindings: kept };
}

/** Smallest useful persisted state shape, used to reserve room for visible summary content. */
function minimalStateForLimit(state: ReviewState, maxLength: number): ReviewState {
  const base = { ...state, postedFindings: [] };
  if (serializeState(base).length <= maxLength) {
    return base;
  }
  return { v: state.v, postedFindings: [] };
}

/** Keep enough room for required body markers before fitting the serialized state marker. */
function fitStateForBody(body: string, state: ReviewState, maxLength: number): ReviewState {
  const stripped = body.replace(STATE_MARKER_RE, "").trimEnd();
  const separator = "\n\n";
  const preservedPrefix = stripped.startsWith(REVIEW_MARKER) ? REVIEW_MARKER : "";
  const minimalStateLength = serializeState(minimalStateForLimit(state, maxLength)).length;
  const maxBodyLength = maxLength - minimalStateLength - separator.length;
  if (maxBodyLength < preservedPrefix.length) {
    throw new Error("prowl-review state marker cannot fit with the required summary marker");
  }

  const reservedBodyLength = Math.min(stripped.length, maxBodyLength);
  const stateMaxLength = maxLength - reservedBodyLength - separator.length;
  if (stateMaxLength <= 0) {
    throw new Error("prowl-review state marker cannot fit with the required summary marker");
  }

  const fittedState = fitStateWithinCommentLimit(state, stateMaxLength);
  if (serializeState(fittedState).length > stateMaxLength) {
    throw new Error("prowl-review state marker cannot fit with the required summary marker");
  }
  return fittedState;
}

/**
 * Extract and validate persisted state from a comment body, or null when the
 * body has no (valid) state marker. Tolerant: a malformed/old marker parses to
 * null so the run falls back to a fresh first-review rather than throwing.
 */
export function parseState(body: string | null | undefined): ReviewState | null {
  if (!body) {
    return null;
  }
  const match = STATE_MARKER_RE.exec(body);
  if (!match) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const result = ReviewStateSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Embed (or replace) the state marker in a summary body. Kept on its own line at
 * the end so it never disturbs the rendered Markdown above it.
 */
export function embedStateWithFittedState(body: string, state: ReviewState, maxLength?: number): EmbeddedState {
  const stripped = body.replace(STATE_MARKER_RE, "").trimEnd();
  const separator = "\n\n";
  const fittedState = maxLength === undefined ? state : fitStateForBody(stripped, state, maxLength);
  const marker = serializeState(fittedState);
  const embedded = `${stripped}${separator}${marker}`;
  if (maxLength === undefined || embedded.length <= maxLength) {
    return { body: embedded, state: fittedState };
  }

  if (marker.length === maxLength) {
    return { body: marker, state: fittedState };
  }
  if (marker.length > maxLength) {
    throw new Error("prowl-review state marker exceeds the GitHub comment body limit");
  }

  const maxBodyLength = maxLength - marker.length - separator.length;
  if (maxBodyLength <= 0) {
    return { body: marker, state: fittedState };
  }

  const notice = `\n\n${SUMMARY_BODY_TRUNCATION_NOTICE}`;
  const truncatedLength = maxBodyLength - notice.length;
  const truncated =
    truncatedLength > 0
      ? `${stripped.slice(0, truncatedLength).trimEnd()}${notice}`
      : stripped.slice(0, maxBodyLength).trimEnd();
  return { body: `${truncated}${separator}${marker}`, state: fittedState };
}

/**
 * Embed (or replace) the state marker in a summary body. Kept on its own line at
 * the end so it never disturbs the rendered Markdown above it.
 */
export function embedState(body: string, state: ReviewState, maxLength?: number): string {
  return embedStateWithFittedState(body, state, maxLength).body;
}
