import { z } from "zod";
import { GITHUB_COMMENT_BODY_LIMIT } from "./state.js";

/**
 * Repo-wide learnings store (backlog #30) — the cross-PR persistence that makes
 * an `@prowl-review ignore` / `resolve` on one PR teach *every* future PR in the
 * repo, not just the PR it was muted on (which is the per-PR #12 state marker).
 *
 * Like #12, this needs no external infrastructure: the store is a small versioned
 * JSON blob embedded in a hidden HTML-comment marker inside a single dedicated
 * GitHub Issue ({@link LEARNINGS_ISSUE_TITLE}). The reviewer finds the open issue
 * by its marker, parses the muted fingerprints, and unions them into the
 * suppression set for the PR under review. Closing the issue clears the store
 * (the human off-switch); deleting a line and re-running re-surfaces that finding.
 *
 * This module is pure (serialize / parse / merge / render); the GitHub
 * read/write side lives in `github/review.ts`.
 */

/** Bump when the persisted shape changes incompatibly. */
export const REPO_LEARNINGS_VERSION = 1;

/** Title of the dedicated issue that holds the repo-wide learnings store. */
export const LEARNINGS_ISSUE_TITLE = "prowl-review: learned patterns";

/** Dedicated label used to find the repo-wide learnings issue without broad scans. */
export const LEARNINGS_ISSUE_LABEL = "prowl-review:learnings";

/** Hard cap on stored patterns so the issue body stays manageable; oldest drop first. */
export const MAX_LEARNED_PATTERNS = 1000;

const MARKER_PREFIX = "<!-- prowl-review:learnings ";
const MARKER_SUFFIX = " -->";

/** Matches the persisted learnings marker and captures its single-line JSON payload. */
const MARKER_RE = /<!-- prowl-review:learnings (\{[^\r\n]*\}) -->/;
const VISIBLE_PATTERNS_HEADING_RE = /^## Muted patterns \(\d+\)\s*$/m;
const VISIBLE_PATTERN_RE = /^- `([^`\r\n]+)`/gm;

/** A single muted finding remembered repo-wide. */
export const RepoLearningEntrySchema = z
  .object({
    /** The finding fingerprint (the suppression key; see {@link findingFingerprint}). */
    fp: z.string().min(1),
    /** Optional human-readable label for the issue rendering (the finding's title/file). */
    label: z.string().optional()
  })
  .strict();

/** Persisted repo-wide learnings store embedded in the dedicated issue's body. */
export const RepoLearningsSchema = z
  .object({
    /** Schema version for forward-compatible parsing. */
    v: z.literal(REPO_LEARNINGS_VERSION),
    /** Muted finding fingerprints (with optional labels), oldest first. */
    patterns: z.array(RepoLearningEntrySchema).default([])
  })
  .strict();

/** A single muted finding remembered repo-wide. */
export type RepoLearningEntry = z.infer<typeof RepoLearningEntrySchema>;

/** Parsed repo-wide learnings store. */
export type RepoLearnings = z.infer<typeof RepoLearningsSchema>;

/** An empty learnings store. */
export function emptyLearnings(): RepoLearnings {
  return { v: REPO_LEARNINGS_VERSION, patterns: [] };
}

/** Render the hidden learnings marker for embedding in the issue body. */
export function serializeLearnings(state: RepoLearnings): string {
  return `${MARKER_PREFIX}${JSON.stringify(state)}${MARKER_SUFFIX}`;
}

/**
 * Extract and validate the learnings store from an issue body, or null when the
 * body has no (valid) marker. Tolerant: a malformed/old marker parses to null so
 * the reviewer falls back to no repo-wide suppression rather than throwing.
 */
export function parseLearnings(body: string | null | undefined): RepoLearnings | null {
  if (!body) {
    return null;
  }
  const match = MARKER_RE.exec(body);
  if (!match) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const result = RepoLearningsSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  const visible = parseVisibleLearningFingerprints(body);
  if (!visible) {
    return result.data;
  }
  return {
    ...result.data,
    patterns: result.data.patterns.filter((entry) => visible.has(entry.fp))
  };
}

function parseVisibleLearningFingerprints(body: string): Set<string> | null {
  const heading = VISIBLE_PATTERNS_HEADING_RE.exec(body);
  if (!heading) {
    return null;
  }
  const markerIndex = body.indexOf(MARKER_PREFIX, heading.index);
  const section = body.slice(heading.index, markerIndex === -1 ? undefined : markerIndex);
  const fingerprints = new Set<string>();
  for (const match of section.matchAll(VISIBLE_PATTERN_RE)) {
    fingerprints.add(match[1]);
  }
  return fingerprints;
}

/** The muted fingerprints in a learnings store. */
export function learningFingerprints(state: RepoLearnings | null | undefined): string[] {
  return (state?.patterns ?? []).map((entry) => entry.fp);
}

/**
 * Merge new muted findings into the store, de-duplicating by fingerprint
 * (a later label refreshes an existing entry's label without reordering it),
 * and capping the total at {@link MAX_LEARNED_PATTERNS} by dropping the oldest.
 * Returns the merged store and how many fingerprints were newly added.
 */
export function mergeLearnings(
  prior: RepoLearnings | null | undefined,
  additions: RepoLearningEntry[]
): { learnings: RepoLearnings; added: number } {
  const byFingerprint = new Map<string, RepoLearningEntry>();
  for (const entry of prior?.patterns ?? []) {
    byFingerprint.set(entry.fp, entry);
  }
  const before = byFingerprint.size;
  for (const addition of additions) {
    const existing = byFingerprint.get(addition.fp);
    if (existing) {
      // Refresh the label in place (keep original ordering) when a new one arrives.
      if (addition.label && addition.label !== existing.label) {
        byFingerprint.set(addition.fp, { ...existing, label: addition.label });
      }
    } else {
      byFingerprint.set(addition.fp, addition.label ? { fp: addition.fp, label: addition.label } : { fp: addition.fp });
    }
  }
  let patterns = [...byFingerprint.values()];
  if (patterns.length > MAX_LEARNED_PATTERNS) {
    patterns = patterns.slice(patterns.length - MAX_LEARNED_PATTERNS);
  }
  const added = byFingerprint.size - before;
  return { learnings: { v: REPO_LEARNINGS_VERSION, patterns }, added };
}

const ISSUE_INTRO = [
  `# ${LEARNINGS_ISSUE_TITLE}`,
  "",
  "This issue is prowl-review's **repo-wide learnings store**. Each entry below is a finding a",
  "maintainer muted with `@prowl-review ignore` or `@prowl-review resolve`; prowl-review then",
  "suppresses matching findings on **every** future PR in this repo — not just the PR it was muted on.",
  "",
  "- **Re-surface one finding:** delete its line below, then re-run a review.",
  "- **Clear everything / turn it off:** close this issue (prowl-review ignores a closed store).",
  "",
  "_Maintained automatically by prowl-review. The visible list above controls which patterns stay muted._"
].join("\n");

const EMPTY_PATTERNS_LINE = "_No learned patterns yet._";
const MUTED_PATTERNS_HEADING_PREFIX = `${ISSUE_INTRO}\n\n## Muted patterns (`;
const MUTED_PATTERNS_HEADING_SUFFIX = ")\n\n";
const LEARNINGS_JSON_PREFIX = `{"v":${REPO_LEARNINGS_VERSION},"patterns":[`;
const LEARNINGS_JSON_SUFFIX = "]}";
const BODY_MARKER_SEPARATOR = "\n\n";

function renderPatternLine(entry: RepoLearningEntry): string {
  return `- \`${entry.fp}\` — ${entry.label ?? "(no description recorded)"}`;
}

/** Build the full issue body (visible prose + hidden marker) for a store. */
function renderBody(state: RepoLearnings): string {
  const lines = state.patterns.length === 0 ? [EMPTY_PATTERNS_LINE] : state.patterns.map(renderPatternLine);
  const prose = `${ISSUE_INTRO}\n\n## Muted patterns (${state.patterns.length})\n\n${lines.join("\n")}`;
  return `${prose}\n\n${serializeLearnings(state)}`;
}

function retainedBodyLength(count: number, patternLinesLength: number, patternJsonLength: number): number {
  const linesLength = count === 0 ? EMPTY_PATTERNS_LINE.length : patternLinesLength + count - 1;
  const markerPayloadLength = LEARNINGS_JSON_PREFIX.length + patternJsonLength + Math.max(0, count - 1) + LEARNINGS_JSON_SUFFIX.length;
  return (
    MUTED_PATTERNS_HEADING_PREFIX.length +
    String(count).length +
    MUTED_PATTERNS_HEADING_SUFFIX.length +
    linesLength +
    BODY_MARKER_SEPARATOR.length +
    MARKER_PREFIX.length +
    markerPayloadLength +
    MARKER_SUFFIX.length
  );
}

/** A rendered learnings issue body plus the fitted state it actually persists. */
export interface FittedLearningsIssueBody {
  body: string;
  learnings: RepoLearnings;
  dropped: number;
}

/**
 * Render a human-readable issue body that carries the hidden learnings marker,
 * dropping the oldest patterns until the whole rendered body (prose + marker)
 * fits within GitHub's comment-body limit. Prose and marker are always fitted
 * together so the visible list never disagrees with the persisted store.
 */
export function fitLearningsIssueBody(state: RepoLearnings): FittedLearningsIssueBody {
  const patterns = [...state.patterns];
  const lineSuffixLengths = Array.from({ length: patterns.length + 1 }, () => 0);
  const jsonSuffixLengths = Array.from({ length: patterns.length + 1 }, () => 0);
  for (let index = patterns.length - 1; index >= 0; index -= 1) {
    lineSuffixLengths[index] = lineSuffixLengths[index + 1] + renderPatternLine(patterns[index]).length;
    jsonSuffixLengths[index] = jsonSuffixLengths[index + 1] + JSON.stringify(patterns[index]).length;
  }

  const fullLength = retainedBodyLength(patterns.length, lineSuffixLengths[0], jsonSuffixLengths[0]);
  if (fullLength <= GITHUB_COMMENT_BODY_LIMIT) {
    const learnings: RepoLearnings = { v: REPO_LEARNINGS_VERSION, patterns };
    return { body: renderBody(learnings), learnings, dropped: 0 };
  }

  let bestStart = patterns.length;
  for (let start = patterns.length; start >= 0; start -= 1) {
    const count = patterns.length - start;
    const length = retainedBodyLength(count, lineSuffixLengths[start], jsonSuffixLengths[start]);
    if (length > GITHUB_COMMENT_BODY_LIMIT) {
      break;
    }
    bestStart = start;
  }

  const fittedPatterns = patterns.slice(bestStart);
  const learnings: RepoLearnings = { v: REPO_LEARNINGS_VERSION, patterns: fittedPatterns };
  return { body: renderBody(learnings), learnings, dropped: patterns.length - fittedPatterns.length };
}

/**
 * Render a human-readable issue body that carries the hidden learnings marker,
 * dropping the oldest patterns until the whole rendered body fits.
 */
export function renderLearningsIssueBody(state: RepoLearnings): string {
  return fitLearningsIssueBody(state).body;
}
