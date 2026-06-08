import type { DiffFile, DiffFileStatus, DiffHunk, DiffLine, ParsedDiff } from "./diff-types.js";

/** Match a unified-diff hunk header and capture old/new ranges plus section text. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

interface GitPathToken {
  value: string;
  next: number;
}

/** Strip a leading `a/` or `b/` git path prefix. */
function stripPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }
  return path;
}

/** Append a JavaScript string's UTF-8 bytes to a byte array. */
function pushUtf8Bytes(bytes: number[], value: string): void {
  bytes.push(...Buffer.from(value, "utf8"));
}

/** Decode one git C-quoted path token, including octal UTF-8 byte escapes. */
function decodeGitQuotedPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("\"") || !trimmed.endsWith("\"")) {
    return trimmed;
  }

  const bytes: number[] = [];
  const body = trimmed.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      pushUtf8Bytes(bytes, char);
      continue;
    }

    const next = body[index + 1];
    if (next === undefined) {
      pushUtf8Bytes(bytes, "\\");
      continue;
    }

    const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += octal[0].length;
      continue;
    }

    const escapes: Record<string, number | string> = {
      a: 7,
      b: 8,
      f: 12,
      n: 10,
      r: 13,
      t: 9,
      v: 11,
      "\\": "\\",
      "\"": "\""
    };
    const escaped = escapes[next];
    if (typeof escaped === "number") {
      bytes.push(escaped);
    } else {
      pushUtf8Bytes(bytes, escaped ?? next);
    }
    index += 1;
  }

  return Buffer.from(bytes).toString("utf8");
}

/** Decode a git path and strip the synthetic diff-side prefix if present. */
function normalizeDiffPath(path: string): string {
  return stripPrefix(decodeGitQuotedPath(path));
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

/** Read one quoted or unquoted path token from a `diff --git` header tail. */
function readGitPathToken(input: string, start: number): GitPathToken | null {
  let index = start;
  while (/\s/.test(input[index] ?? "")) {
    index += 1;
  }

  if (index >= input.length) {
    return null;
  }

  if (input[index] === "\"") {
    let token = "\"";
    index += 1;
    let escaped = false;
    for (; index < input.length; index += 1) {
      const char = input[index];
      token += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        index += 1;
        break;
      }
    }
    return { value: decodeGitQuotedPath(token), next: index };
  }

  const tokenStart = index;
  while (index < input.length && !/\s/.test(input[index])) {
    index += 1;
  }
  return { value: input.slice(tokenStart, index), next: index };
}

/** Parse unquoted `diff --git` paths, including spaces inside path names. */
function parseUnquotedDiffGitPaths(input: string): { oldPath: string; newPath: string } | null {
  const tail = input.trimStart();
  if (!tail.startsWith("a/")) {
    return null;
  }

  const split = tail.indexOf(" b/", 2);
  if (split === -1) {
    return null;
  }

  return {
    oldPath: stripPrefix(tail.slice(0, split)),
    newPath: stripPrefix(tail.slice(split + 1))
  };
}

/** Parse the old and new path tokens from a `diff --git` line. */
function parseDiffGitPaths(raw: string): { oldPath: string; newPath: string } | null {
  const tail = raw.slice("diff --git ".length);
  const unquoted = parseUnquotedDiffGitPaths(tail);
  if (unquoted) {
    return unquoted;
  }

  const first = readGitPathToken(tail, 0);
  if (!first) {
    return null;
  }
  const second = readGitPathToken(tail, first.next);
  if (!second) {
    return null;
  }
  return {
    oldPath: stripPrefix(first.value),
    newPath: stripPrefix(second.value)
  };
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
      const paths = parseDiffGitPaths(raw);
      const path = paths?.newPath ?? "";
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
      current.oldPath = decodeGitQuotedPath(raw.slice("rename from ".length));
      continue;
    }
    if (raw.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = decodeGitQuotedPath(raw.slice("rename to ".length));
      continue;
    }
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      current.binary = true;
      continue;
    }
    if (!hunk && raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      if (p !== "/dev/null") {
        current.oldPath = current.oldPath ?? normalizeDiffPath(p);
      }
      continue;
    }
    if (!hunk && raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      if (p !== "/dev/null") {
        current.path = normalizeDiffPath(p);
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
