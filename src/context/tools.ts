import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Sandboxed repo-access tools for agentic cross-file context retrieval.
 *
 * These are the concrete capabilities the review agent drives on demand
 * (read-file + grep/search + list) — no vector DB, no embeddings. Every path is
 * confined to the repo root (path-traversal guard, part of backlog #14) and
 * every operation is bounded so a single review can't read the whole tree.
 */

export interface ToolkitOptions {
  /** Absolute path to the repo root. All access is confined to this directory. */
  root: string;
  /** Max bytes returned by a single file read. Default 64 KiB. */
  maxFileBytes?: number;
  /** Max matches returned by a single search. Default 200. */
  maxMatches?: number;
  /** Max files returned by list and visited by search. Default 2000. */
  maxListedFiles?: number;
  /** Max bytes returned for a single matching search line. Default 1024. */
  maxMatchTextBytes?: number;
  /** Directory/segment names skipped during search/list. */
  ignore?: string[];
}

export interface SearchOptions {
  /** Optional search-only predicate; false skips the file before search caps apply. */
  shouldSearchFile?: (path: string) => boolean;
}

export const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  ".prowl-review",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo"
];

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_MAX_LISTED_FILES = 2000;
const DEFAULT_MAX_MATCH_TEXT_BYTES = 1024;
const MAX_SEARCH_PATTERN_LENGTH = 256;
const MAX_BOUNDED_REPEAT = 100;
const MAX_UNBOUNDED_REPETITIONS = 4;

/** Thrown when a requested path escapes the repo root or doesn't exist. */
export class RepoAccessError extends Error {}

export interface ReadFileResult {
  path: string;
  content: string;
  /** True when the file was longer than the byte cap and content was truncated. */
  truncated: boolean;
  /** Bytes actually returned. */
  bytes: number;
}

export interface SearchMatch {
  path: string;
  /** 1-based line number. */
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  /** True when more matches, files, or match text existed than the caps returned/searched. */
  truncated: boolean;
  /** Number of files skipped by the search-only predicate before reading. */
  skippedFiles?: number;
}

export interface ListFilesResult {
  files: string[];
  /** True when more files existed than the cap returned. */
  truncated: boolean;
}

/** Resolve a repo-relative path, rejecting anything that escapes the root. */
function safeResolve(root: string, requested: string): string {
  const abs = resolve(root, requested);
  const rel = relative(root, abs);
  if (rel === "") {
    return abs; // the root itself
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new RepoAccessError(`Path escapes repo root: ${requested}`);
  }
  return abs;
}

/** Reject symlinked path components before an operation can follow them. */
function assertNoSymlinkPath(root: string, abs: string, requested: string): void {
  const rootAbs = resolve(root);
  const rel = relative(rootAbs, abs);
  if (rel === "") {
    return;
  }

  let current = rootAbs;
  for (const part of rel.split(/[\\/]+/)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new RepoAccessError(`Symlinks are not allowed: ${requested}`);
      }
    } catch (error) {
      if (error instanceof RepoAccessError) {
        throw error;
      }
      return;
    }
  }
}

function isIgnored(name: string, ignore: string[]): boolean {
  return ignore.includes(name);
}

/** Reject paths that include ignored directory/file segments. */
function assertNotIgnoredPath(root: string, abs: string, requested: string, ignore: string[]): void {
  const rel = relative(resolve(root), abs);
  if (rel === "") {
    return;
  }
  const ignored = rel.split(/[\\/]+/).find((part) => isIgnored(part, ignore));
  if (ignored) {
    throw new RepoAccessError(`Path includes ignored segment '${ignored}': ${requested}`);
  }
}

function boundedCount(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function walkRepoFiles(
  options: ToolkitOptions,
  dir: string,
  visit: (file: string, abs: string) => boolean | void,
  shouldVisitFile?: (file: string) => boolean
): { truncated: boolean; skippedFiles: number } {
  const ignore = options.ignore ?? DEFAULT_IGNORE;
  const maxFiles = boundedCount(options.maxListedFiles, DEFAULT_MAX_LISTED_FILES);
  const base = safeResolve(options.root, dir);
  assertNotIgnoredPath(options.root, base, dir, ignore);
  assertNoSymlinkPath(options.root, base, dir);
  let baseStat;
  try {
    baseStat = statSync(base);
  } catch {
    throw new RepoAccessError(`Directory not found: ${dir}`);
  }
  if (!baseStat.isDirectory()) {
    throw new RepoAccessError(`Not a directory: ${dir}`);
  }
  let visitedFiles = 0;
  let skippedFiles = 0;
  let truncated = false;

  const walk = (absDir: string, isStartDir = false): boolean => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      if (isStartDir) {
        throw new RepoAccessError(`Directory not readable: ${dir}`);
      }
      return true;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isIgnored(entry.name, ignore)) {
        continue;
      }
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (!walk(abs)) {
          return false;
        }
      } else if (entry.isFile()) {
        const file = relative(options.root, abs);
        if (shouldVisitFile && !shouldVisitFile(file)) {
          skippedFiles += 1;
          continue;
        }
        if (visitedFiles >= maxFiles) {
          truncated = true;
          return false;
        }
        visitedFiles += 1;
        if (visit(file, abs) === false) {
          return false;
        }
      }
    }
    return true;
  };

  walk(base, true);
  return { truncated, skippedFiles };
}

/** Return a quantifier at `index`, marking unbounded or very large repeats as risky. */
function quantifierAt(pattern: string, index: number): { end: number; unbounded: boolean } | undefined {
  const char = pattern[index];
  if (char === "*" || char === "+") {
    return { end: index, unbounded: true };
  }
  if (char !== "{") {
    return undefined;
  }

  const end = pattern.indexOf("}", index + 1);
  if (end === -1) {
    return undefined;
  }

  const body = pattern.slice(index + 1, end);
  const match = /^(\d+)(?:,(\d*))?$/.exec(body);
  if (!match) {
    return undefined;
  }

  const lower = Number(match[1]);
  const upper = match[2] === undefined ? lower : match[2] === "" ? Infinity : Number(match[2]);
  return { end, unbounded: upper === Infinity || upper > MAX_BOUNDED_REPEAT || lower > MAX_BOUNDED_REPEAT };
}

/** Detect simple safe-regex-style red flags such as `(a+)+` and `(a|aa)+`. */
function hasUnsafeQuantifiedGroup(pattern: string): boolean {
  const stack: Array<{ hasAlternation: boolean; hasUnboundedQuantifier: boolean }> = [];
  let escaped = false;
  let inCharClass = false;

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inCharClass) {
      if (char === "]") {
        inCharClass = false;
      }
      continue;
    }
    if (char === "[") {
      inCharClass = true;
      continue;
    }
    if (char === "(") {
      stack.push({ hasAlternation: false, hasUnboundedQuantifier: false });
      continue;
    }
    if (char === ")") {
      const group = stack.pop();
      if (!group) {
        continue;
      }
      const outer = quantifierAt(pattern, i + 1);
      if (outer?.unbounded && (group.hasAlternation || group.hasUnboundedQuantifier)) {
        return true;
      }
      if (outer?.unbounded && stack.length > 0) {
        stack[stack.length - 1].hasUnboundedQuantifier = true;
      }
      continue;
    }
    if (char === "|" && stack.length > 0) {
      stack[stack.length - 1].hasAlternation = true;
      continue;
    }

    const quantifier = quantifierAt(pattern, i);
    if (quantifier) {
      if (quantifier.unbounded && stack.length > 0) {
        stack[stack.length - 1].hasUnboundedQuantifier = true;
      }
      i = quantifier.end;
    }
  }

  return false;
}

/** Cap broad repetition so an LLM cannot compose many overlapping wildcards. */
function countUnboundedRepetitions(pattern: string): number {
  let count = 0;
  let escaped = false;
  let inCharClass = false;

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inCharClass) {
      if (char === "]") {
        inCharClass = false;
      }
      continue;
    }
    if (char === "[") {
      inCharClass = true;
      continue;
    }

    const quantifier = quantifierAt(pattern, i);
    if (quantifier) {
      if (quantifier.unbounded) {
        count += 1;
      }
      i = quantifier.end;
    }
  }

  return count;
}

/** Keep model-supplied search regexes in a low-complexity subset. */
function assertSafeSearchPattern(pattern: string): void {
  if (pattern.length > MAX_SEARCH_PATTERN_LENGTH) {
    throw new RepoAccessError(
      `Unsafe search pattern: exceeds ${MAX_SEARCH_PATTERN_LENGTH} characters`
    );
  }
  if (/\\(?:[1-9]|k<[^>]+>)/.test(pattern)) {
    throw new RepoAccessError("Unsafe search pattern: backreferences are not allowed");
  }
  if (/\(\?(?:[=!]|<[=!])/.test(pattern)) {
    throw new RepoAccessError("Unsafe search pattern: lookarounds are not allowed");
  }
  if (hasUnsafeQuantifiedGroup(pattern)) {
    throw new RepoAccessError("Unsafe search pattern: nested or ambiguous repetition is not allowed");
  }
  if (countUnboundedRepetitions(pattern) > MAX_UNBOUNDED_REPETITIONS) {
    throw new RepoAccessError("Unsafe search pattern: too many unbounded repetitions");
  }
}

/** Read at most `maxBytes` bytes without buffering the rest of the file. */
function readFilePrefix(abs: string, maxBytes: number): Buffer {
  const buffer = Buffer.allocUnsafe(maxBytes);
  const fd = openSync(abs, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function truncateSearchMatchText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { text: "", truncated: text.length > 0 };
  }
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }

  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }

  return { text: `${text.slice(0, end)}...[truncated]`, truncated: true };
}

/** Read a repo file, confined to the root and capped at `maxFileBytes`. */
export function readRepoFile(options: ToolkitOptions, requestedPath: string): ReadFileResult {
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const ignore = options.ignore ?? DEFAULT_IGNORE;
  const abs = safeResolve(options.root, requestedPath);
  assertNotIgnoredPath(options.root, abs, requestedPath, ignore);
  assertNoSymlinkPath(options.root, abs, requestedPath);

  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw new RepoAccessError(`File not found: ${requestedPath}`);
  }
  if (!stat.isFile()) {
    throw new RepoAccessError(`Not a file: ${requestedPath}`);
  }

  const truncated = stat.size > maxBytes;
  const slice = truncated ? readFilePrefix(abs, maxBytes) : readFileSync(abs);

  return {
    path: relative(options.root, abs) || requestedPath,
    content: slice.toString("utf8"),
    truncated,
    bytes: slice.length
  };
}

/** List repo files under a directory (relative paths), skipping ignored dirs. */
export function listRepoFilesDetailed(options: ToolkitOptions, dir = "."): ListFilesResult {
  const files: string[] = [];
  const result = walkRepoFiles(options, dir, (file) => {
    files.push(file);
  });
  return { files: files.sort(), truncated: result.truncated };
}

/** List repo files under a directory (relative paths), skipping ignored dirs. */
export function listRepoFiles(options: ToolkitOptions, dir = "."): string[] {
  return listRepoFilesDetailed(options, dir).files;
}

/**
 * Search repo file contents for a regular expression, returning bounded
 * `{path, line, text}` matches. Binary-looking files are skipped.
 */
export function searchRepo(
  options: ToolkitOptions,
  pattern: string,
  searchDir = ".",
  searchOptions: SearchOptions = {}
): SearchResult {
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxMatchTextBytes = boundedCount(
    options.maxMatchTextBytes,
    DEFAULT_MAX_MATCH_TEXT_BYTES
  );

  let regex: RegExp;
  try {
    assertSafeSearchPattern(pattern);
    regex = new RegExp(pattern);
  } catch (error) {
    if (error instanceof RepoAccessError) {
      throw error;
    }
    throw new RepoAccessError(
      `Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const matches: SearchMatch[] = [];
  let truncated = false;

  const traversal = walkRepoFiles(options, searchDir, (file, abs) => {
    if (matches.length >= maxMatches) {
      truncated = true;
      return false;
    }
    let buffer;
    try {
      assertNoSymlinkPath(options.root, abs, file);
      const stat = statSync(abs);
      if (!stat.isFile()) {
        return undefined;
      }
      if (stat.size > maxFileBytes) {
        truncated = true;
        return undefined;
      }
      buffer = readFileSync(abs);
    } catch {
      return undefined;
    }
    if (buffer.includes(0)) {
      return undefined; // skip binary files
    }
    const lines = buffer.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i])) {
        const matchText = truncateSearchMatchText(lines[i], maxMatchTextBytes);
        if (matchText.truncated) {
          truncated = true;
        }
        matches.push({ path: file, line: i + 1, text: matchText.text });
        if (matches.length >= maxMatches) {
          truncated = true;
          return false;
        }
      }
    }
    return undefined;
  }, searchOptions.shouldSearchFile);

  if (traversal.truncated) {
    truncated = true;
  }

  return { matches, truncated, skippedFiles: traversal.skippedFiles };
}
