import type { DiffFile, SkippedFile } from "./diff-types.js";
import { isSensitiveFile } from "./redact.js";

/** Treat both sides of a rename as sensitive-path evidence. */
export function isSensitiveDiffFile(file: DiffFile): boolean {
  return isSensitiveFile(file.path) || (file.oldPath !== undefined && isSensitiveFile(file.oldPath));
}

/** Split parsed diff files into prompt-safe files and sensitive-path skips. */
export function filterSensitiveDiffFiles(files: DiffFile[]): { files: DiffFile[]; skipped: SkippedFile[] } {
  const safeFiles: DiffFile[] = [];
  const skipped: SkippedFile[] = [];

  for (const file of files) {
    if (isSensitiveDiffFile(file)) {
      skipped.push({ path: file.path, reason: "sensitive" });
    } else {
      safeFiles.push(file);
    }
  }

  return { files: safeFiles, skipped };
}
