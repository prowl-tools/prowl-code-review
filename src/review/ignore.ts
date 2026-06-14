import type { DiffFile, SkippedFile } from "./diff-types.js";

/**
 * Default ignore list (backlog #19): generated/vendored files that add cost and
 * noise without being worth reviewing. Skipped files are reported (never dropped
 * silently, core principle #5) and the list is overridable via `.prowl-review.yml`.
 *
 * Patterns are gitignore-lite globs matched against repo-relative paths:
 *   - a pattern with no `/` matches any path **segment** (so `node_modules`
 *     matches `a/node_modules/b`, and `*.snap` matches `x/y.snap`),
 *   - a pattern with `/` matches the full path and, as a directory prefix, its
 *     contents (so `src/generated` also matches `src/generated/x.ts`),
 *   - `*` matches within a segment, `**` matches across segments, `?` one char.
 *
 * No glob dependency — the matcher is a small, auditable memoized glob matcher,
 * consistent with the rest of the codebase.
 */
export const DEFAULT_IGNORE_GLOBS: readonly string[] = [
  // Dependency + build/output directories.
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  // Lockfiles (generated, large, not worth reviewing line-by-line).
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "composer.lock",
  "go.sum",
  // Test snapshots.
  "__snapshots__",
  "*.snap"
];

/** Normalize a path to forward slashes with no leading `./` or trailing slash. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
}

type CompiledIgnorePattern =
  | { kind: "segment"; pattern: string }
  | { kind: "path"; segments: string[]; contentsSegments: string[] };

/** Normalize and cache ignore patterns once per filtering pass. */
function compileIgnorePatterns(patterns: readonly string[]): CompiledIgnorePattern[] {
  const compiled: CompiledIgnorePattern[] = [];
  for (const raw of patterns) {
    const pattern = normalizePath(raw.trim());
    if (!pattern) {
      continue;
    }
    if (pattern.includes("/")) {
      const segments = pattern.split("/");
      compiled.push({ kind: "path", segments, contentsSegments: [...segments, "**"] });
    } else {
      compiled.push({ kind: "segment", pattern });
    }
  }
  return compiled;
}

/** Match a single path segment against a glob where `*` never crosses `/`. */
function matchSegmentGlob(segment: string, pattern: string): boolean {
  const memo = new Map<string, boolean>();
  const match = (segmentIndex: number, patternIndex: number): boolean => {
    const key = `${segmentIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let result: boolean;
    const token = pattern[patternIndex];
    if (patternIndex === pattern.length) {
      result = segmentIndex === segment.length;
    } else if (token === "*") {
      result =
        match(segmentIndex, patternIndex + 1) ||
        (segmentIndex < segment.length && match(segmentIndex + 1, patternIndex));
    } else if (token === "?") {
      result = segmentIndex < segment.length && match(segmentIndex + 1, patternIndex + 1);
    } else {
      result =
        segmentIndex < segment.length &&
        segment[segmentIndex] === token &&
        match(segmentIndex + 1, patternIndex + 1);
    }

    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

/** Match full path segments, with `**` consuming zero or more complete segments. */
function matchPathGlob(pathSegments: string[], patternSegments: string[]): boolean {
  const memo = new Map<string, boolean>();
  const match = (pathIndex: number, patternIndex: number): boolean => {
    const key = `${pathIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let result: boolean;
    const patternSegment = patternSegments[patternIndex];
    if (patternIndex === patternSegments.length) {
      result = pathIndex === pathSegments.length;
    } else if (patternSegment === "**") {
      result =
        match(pathIndex, patternIndex + 1) ||
        (pathIndex < pathSegments.length && match(pathIndex + 1, patternIndex));
    } else {
      result =
        pathIndex < pathSegments.length &&
        matchSegmentGlob(pathSegments[pathIndex], patternSegment) &&
        match(pathIndex + 1, patternIndex + 1);
    }

    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

/** True when `path` matches any precompiled ignore pattern. */
function isIgnoredByCompiledPatterns(path: string, patterns: readonly CompiledIgnorePattern[]): boolean {
  const normalized = normalizePath(path);
  if (!normalized) {
    return false;
  }
  const segments = normalized.split("/");

  for (const pattern of patterns) {
    if (pattern.kind === "segment") {
      if (segments.some((segment) => matchSegmentGlob(segment, pattern.pattern))) {
        return true;
      }
    } else if (matchPathGlob(segments, pattern.segments) || matchPathGlob(segments, pattern.contentsSegments)) {
      return true;
    }
  }
  return false;
}

/** True when `path` matches any ignore `patterns`. */
export function isIgnoredPath(path: string, patterns: readonly string[]): boolean {
  return isIgnoredByCompiledPatterns(path, compileIgnorePatterns(patterns));
}

/**
 * Split parsed diff files into kept files and ignore-list skips. Mirrors
 * {@link filterSensitiveDiffFiles}: every input file is either kept or reported
 * as skipped (reason `"ignored"`) — nothing is dropped silently.
 */
export function filterIgnoredDiffFiles(
  files: DiffFile[],
  patterns: readonly string[]
): { files: DiffFile[]; skipped: SkippedFile[] } {
  const kept: DiffFile[] = [];
  const skipped: SkippedFile[] = [];
  const compiledPatterns = compileIgnorePatterns(patterns);

  for (const file of files) {
    if (isIgnoredByCompiledPatterns(file.path, compiledPatterns)) {
      skipped.push({ path: file.path, reason: "ignored" });
    } else {
      kept.push(file);
    }
  }

  return { files: kept, skipped };
}
