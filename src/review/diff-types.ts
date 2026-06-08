/**
 * Structured representation of a unified diff.
 *
 * The new-side line numbers captured here are what later stages use to place
 * inline review comments on exact lines (backlog #10).
 */

export type DiffLineType = "add" | "del" | "context";

export interface DiffLine {
  type: DiffLineType;
  /** Line text without the leading +/-/space marker. */
  content: string;
  /** 1-based line number in the old file (del + context lines). */
  oldLine?: number;
  /** 1-based line number in the new file (add + context lines). */
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Optional section heading after the `@@ ... @@` marker. */
  section: string;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  /** Current path (new side); for deletions this is the removed path. */
  path: string;
  /** Previous path, set for renames. */
  oldPath?: string;
  status: DiffFileStatus;
  /** True for binary files (no textual hunks available). */
  binary: boolean;
  hunks: DiffHunk[];
  /** Byte size of this file's diff text (used by size guards). */
  byteSize: number;
}

export interface ParsedDiff {
  files: DiffFile[];
}

export interface DiffLimits {
  /** Maximum number of files to include. */
  maxFiles?: number;
  /** Maximum cumulative diff bytes to include. */
  maxDiffBytes?: number;
}

export type SkipReason = "maxFiles" | "maxDiffBytes" | "binary";

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface GuardedDiff {
  /** Files included for review. */
  files: DiffFile[];
  /** Files omitted by a cap or because they are binary — reported, never silently dropped. */
  skipped: SkippedFile[];
  /** True when any file was skipped due to a size cap. */
  truncated: boolean;
}
