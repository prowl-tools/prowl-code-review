/**
 * Structured representation of a unified diff.
 *
 * The new-side line numbers captured here are what later stages use to place
 * inline review comments on exact lines (backlog #10).
 */

/** Type of one parsed unified-diff line. */
export type DiffLineType = "add" | "del" | "context";

/** One content line inside a parsed diff hunk. */
export interface DiffLine {
  /** Whether this line is added, deleted, or unchanged context. */
  type: DiffLineType;
  /** Line text without the leading +/-/space marker. */
  content: string;
  /** 1-based line number in the old file (del + context lines). */
  oldLine?: number;
  /** 1-based line number in the new file (add + context lines). */
  newLine?: number;
}

/** One unified-diff hunk with header metadata and parsed lines. */
export interface DiffHunk {
  /** Starting line number in the old file. */
  oldStart: number;
  /** Number of old-file lines covered by the hunk. */
  oldLines: number;
  /** Starting line number in the new file. */
  newStart: number;
  /** Number of new-file lines covered by the hunk. */
  newLines: number;
  /** Optional section heading after the `@@ ... @@` marker. */
  section: string;
  /** Parsed lines belonging to this hunk. */
  lines: DiffLine[];
}

/** File-level change status inferred from unified-diff headers. */
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

/** One changed file parsed from a unified diff. */
export interface DiffFile {
  /** Current path (new side); for deletions this is the removed path. */
  path: string;
  /** Previous path, set for renames. */
  oldPath?: string;
  /** File-level change status. */
  status: DiffFileStatus;
  /** True for binary files (no textual hunks available). */
  binary: boolean;
  /** Parsed textual hunks for this file. */
  hunks: DiffHunk[];
  /** Byte size of this file's diff text (used by size guards). */
  byteSize: number;
}

/** Parsed representation of a complete unified diff. */
export interface ParsedDiff {
  /** Changed files found in the diff. */
  files: DiffFile[];
}

/** Optional limits for selecting how much parsed diff to review. */
export interface DiffLimits {
  /** Maximum number of files to include. */
  maxFiles?: number;
  /** Maximum cumulative diff bytes to include. */
  maxDiffBytes?: number;
}

/** Reason a file was omitted from review input. */
export type SkipReason = "maxFiles" | "maxDiffBytes" | "binary";

/** File omitted from review input and the reason it was skipped. */
export interface SkippedFile {
  /** File path that was skipped. */
  path: string;
  /** Why the file was skipped. */
  reason: SkipReason;
}

/** Parsed diff after applying review-size guardrails. */
export interface GuardedDiff {
  /** Files included for review. */
  files: DiffFile[];
  /** Files omitted by a cap or because they are binary — reported, never silently dropped. */
  skipped: SkippedFile[];
  /** True when any file was skipped due to a size cap. */
  truncated: boolean;
}
