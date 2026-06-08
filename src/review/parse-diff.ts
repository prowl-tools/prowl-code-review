import type { DiffFile, DiffFileStatus, DiffHunk, DiffLine, ParsedDiff } from "./diff-types.js";

/** Match a unified-diff hunk header and capture old/new ranges plus section text. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Strip a leading `a/` or `b/` git path prefix. */
function stripPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }
  return path;
}

/** Return the UTF-8 byte size for a split diff line and its separator, if any. */
function byteSizeOfSplitLine(raw: string, index: number, lineCount: number): number {
  const newlineBytes = index < lineCount - 1 ? 1 : 0;
  return Buffer.byteLength(raw, "utf8") + newlineBytes;
}

/** Append the active file to the parsed output, if a file is currently open. */
function pushCurrentFile(files: DiffFile[], current: DiffFile | null): void {
  if (current) {
    files.push(current);
  }
}

/**
 * Parse a unified git diff (as returned by the GitHub API `format: "diff"`) into
 * a structured {@link ParsedDiff}. Pure and network-free.
 *
 * Handles added/modified/deleted/renamed and binary files, multiple hunks, and
 * the `\ No newline at end of file` marker. Tracks old/new line numbers per line.
 */
export function parseDiff(text: string): ParsedDiff {
  const files: DiffFile[] = [];
  const lines = text.split("\n");

  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.startsWith("diff --git ")) {
      pushCurrentFile(files, current);
      hunk = null;
      // `diff --git a/path b/path`
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      const path = match ? stripPrefix(`b/${match[2]}`) : "";
      current = {
        path,
        status: "modified",
        binary: false,
        hunks: [],
        byteSize: 0
      };
    }

    if (!current) {
      continue;
    }

    current.byteSize += byteSizeOfSplitLine(raw, index, lines.length);

    if (raw.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (raw.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = raw.slice("rename from ".length).trim();
      continue;
    }
    if (raw.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = raw.slice("rename to ".length).trim();
      continue;
    }
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      current.binary = true;
      continue;
    }
    if (!hunk && raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      if (p !== "/dev/null") {
        current.oldPath = current.oldPath ?? stripPrefix(p);
      }
      continue;
    }
    if (!hunk && raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      if (p !== "/dev/null") {
        current.path = stripPrefix(p);
      }
      continue;
    }

    const header = HUNK_HEADER.exec(raw);
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        section: header[5].trim(),
        lines: []
      };
      current.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }

    if (!hunk) {
      continue; // still in the file header preamble
    }

    if (raw.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    }

    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === "+") {
      const line: DiffLine = { type: "add", content, newLine };
      hunk.lines.push(line);
      newLine += 1;
    } else if (marker === "-") {
      const line: DiffLine = { type: "del", content, oldLine };
      hunk.lines.push(line);
      oldLine += 1;
    } else if (marker === " ") {
      const line: DiffLine = { type: "context", content, oldLine, newLine };
      hunk.lines.push(line);
      oldLine += 1;
      newLine += 1;
    }
    // Any other line inside a hunk (shouldn't occur in well-formed diffs) is ignored.
  }

  pushCurrentFile(files, current);

  // Normalize: a deleted file's path is its old path.
  for (const file of files) {
    if (file.status === "deleted" && file.oldPath) {
      file.path = file.oldPath;
    }
  }

  return { files };
}

/** Re-export for convenience. */
export type { DiffFile, DiffFileStatus, DiffHunk, DiffLine, ParsedDiff };
