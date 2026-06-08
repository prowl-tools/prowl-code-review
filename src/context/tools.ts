import { readFileSync, readdirSync, statSync } from "node:fs";
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
  /** Directory/segment names skipped during search/list. */
  ignore?: string[];
}

export const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo"
];

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_MATCHES = 200;

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
  /** True when more matches existed than the cap returned. */
  truncated: boolean;
}

/** Resolve a repo-relative path, rejecting anything that escapes the root. */
function safeResolve(root: string, requested: string): string {
  const abs = resolve(root, requested);
  const rel = relative(root, abs);
  if (rel === "" ) {
    return abs; // the root itself
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new RepoAccessError(`Path escapes repo root: ${requested}`);
  }
  return abs;
}

function isIgnored(name: string, ignore: string[]): boolean {
  return ignore.includes(name);
}

/** Read a repo file, confined to the root and capped at `maxFileBytes`. */
export function readRepoFile(options: ToolkitOptions, requestedPath: string): ReadFileResult {
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const abs = safeResolve(options.root, requestedPath);

  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw new RepoAccessError(`File not found: ${requestedPath}`);
  }
  if (!stat.isFile()) {
    throw new RepoAccessError(`Not a file: ${requestedPath}`);
  }

  const buffer = readFileSync(abs);
  const truncated = buffer.length > maxBytes;
  const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;

  return {
    path: relative(options.root, abs) || requestedPath,
    content: slice.toString("utf8"),
    truncated,
    bytes: slice.length
  };
}

/** List repo files under a directory (relative paths), skipping ignored dirs. */
export function listRepoFiles(options: ToolkitOptions, dir = "."): string[] {
  const ignore = options.ignore ?? DEFAULT_IGNORE;
  const base = safeResolve(options.root, dir);
  const out: string[] = [];

  const walk = (absDir: string) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isIgnored(entry.name, ignore)) {
        continue;
      }
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(relative(options.root, abs));
      }
    }
  };

  walk(base);
  return out.sort();
}

/**
 * Search repo file contents for a regular expression, returning bounded
 * `{path, line, text}` matches. Binary-looking files are skipped.
 */
export function searchRepo(
  options: ToolkitOptions,
  pattern: string,
  searchDir = "."
): SearchResult {
  const ignore = options.ignore ?? DEFAULT_IGNORE;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new RepoAccessError(
      `Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const matches: SearchMatch[] = [];
  let truncated = false;

  for (const file of listRepoFiles(options, searchDir)) {
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    const abs = join(options.root, file);
    let buffer;
    try {
      buffer = readFileSync(abs);
    } catch {
      continue;
    }
    if (buffer.length > maxFileBytes || buffer.includes(0)) {
      continue; // skip oversized or binary files
    }
    const lines = buffer.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i])) {
        matches.push({ path: file, line: i + 1, text: lines[i] });
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
      }
    }
  }

  return { matches, truncated };
}
