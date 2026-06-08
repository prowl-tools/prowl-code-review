import type { DiffFile, DiffFileStatus, DiffHunk, DiffLine, ParsedDiff } from "./diff-types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Strip a leading `a/` or `b/` git path prefix. */
function stripPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }
  return path;
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

  const pushFile = () => {
    if (current) {
      files.push(current);
    }
  };

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      pushFile();
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

    current.byteSize += raw.length + 1; // include the newline we split on

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
    if (raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      if (p !== "/dev/null") {
        current.oldPath = current.oldPath ?? stripPrefix(p);
      }
      continue;
    }
    if (raw.startsWith("+++ ")) {
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

  pushFile();

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
