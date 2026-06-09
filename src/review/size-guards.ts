import type { DiffLimits, GuardedDiff, ParsedDiff, SkipReason, SkippedFile } from "./diff-types.js";

/**
 * Apply size caps to a parsed diff, returning the files to review plus an
 * explicit list of what was skipped and why. Nothing is dropped silently
 * (core principle #5) — callers report `skipped`/`truncated` in the review.
 *
 * Order of precedence per file:
 *   1. binary files are never reviewable → skipped (reason "binary")
 *   2. once `maxFiles` is reached → remaining files skipped (reason "maxFiles")
 *   3. once including a file would exceed `maxDiffBytes` → it (and the rest)
 *      are skipped (reason "maxDiffBytes")
 */
export function applyDiffLimits(parsed: ParsedDiff, limits: DiffLimits = {}): GuardedDiff {
  const { maxFiles, maxDiffBytes } = limits;
  const files: GuardedDiff["files"] = [];
  const skipped: SkippedFile[] = [];
  let truncated = false;
  let includedBytes = 0;

  for (const file of parsed.files) {
    if (file.binary) {
      skipped.push({ path: file.path, reason: "binary" });
      continue;
    }

    if (maxFiles !== undefined && files.length >= maxFiles) {
      skipped.push({ path: file.path, reason: "maxFiles" });
      truncated = true;
      continue;
    }

    if (maxDiffBytes !== undefined && includedBytes + file.byteSize > maxDiffBytes) {
      skipped.push({ path: file.path, reason: "maxDiffBytes" });
      truncated = true;
      continue;
    }

    files.push(file);
    includedBytes += file.byteSize;
  }

  return { files, skipped, truncated };
}

/** Human-readable note summarizing skipped files, for inclusion in a review. */
export function describeSkipped(skipped: SkippedFile[]): string {
  if (skipped.length === 0) {
    return "";
  }
  const byReason = new Map<SkipReason, string[]>();
  for (const { path, reason } of skipped) {
    const list = byReason.get(reason) ?? [];
    list.push(path);
    byReason.set(reason, list);
  }
  const labels: Record<SkipReason, string> = {
    binary: "binary (not reviewable)",
    maxFiles: "skipped - file limit reached",
    maxDiffBytes: "skipped - diff size limit reached",
    sensitive: "sensitive - kept out of the prompt"
  };
  const parts: string[] = [];
  for (const [reason, paths] of byReason) {
    parts.push(`${labels[reason]}: ${paths.join(", ")}`);
  }
  return parts.join("; ");
}
