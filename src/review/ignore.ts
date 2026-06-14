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
 * No glob dependency — the matcher is a small, auditable iterative glob matcher,
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

interface GlobMatchCache {
  segments: Map<string, boolean>;
  paths: Map<string, boolean>;
}

function createGlobMatchCache(): GlobMatchCache {
  return { segments: new Map(), paths: new Map() };
}

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
function matchSegmentGlob(segment: string, pattern: string, cache?: GlobMatchCache): boolean {
  const cacheKey = `${segment}\0${pattern}`;
  const cached = cache?.segments.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let previous = new Array<boolean>(pattern.length + 1).fill(false);
  previous[0] = true;
  for (let patternIndex = 1; patternIndex <= pattern.length; patternIndex += 1) {
    previous[patternIndex] = pattern[patternIndex - 1] === "*" && previous[patternIndex - 1];
  }

  for (let segmentIndex = 1; segmentIndex <= segment.length; segmentIndex += 1) {
    const current = new Array<boolean>(pattern.length + 1).fill(false);
    for (let patternIndex = 1; patternIndex <= pattern.length; patternIndex += 1) {
      const token = pattern[patternIndex - 1];
      if (token === "*") {
        current[patternIndex] = current[patternIndex - 1] || previous[patternIndex];
      } else if (token === "?") {
        current[patternIndex] = previous[patternIndex - 1];
      } else {
        current[patternIndex] = previous[patternIndex - 1] && segment[segmentIndex - 1] === token;
      }
    }
    previous = current;
  }

  const result = previous[pattern.length];
  cache?.segments.set(cacheKey, result);
  return result;
}

/** Match full path segments, with `**` consuming zero or more complete segments. */
function matchPathGlob(pathSegments: string[], patternSegments: string[], cache?: GlobMatchCache): boolean {
  const cacheKey = `${pathSegments.join("/")}\0${patternSegments.join("/")}`;
  const cached = cache?.paths.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let previous = new Array<boolean>(patternSegments.length + 1).fill(false);
  previous[0] = true;
  for (let patternIndex = 1; patternIndex <= patternSegments.length; patternIndex += 1) {
    previous[patternIndex] = patternSegments[patternIndex - 1] === "**" && previous[patternIndex - 1];
  }

  for (let pathIndex = 1; pathIndex <= pathSegments.length; pathIndex += 1) {
    const current = new Array<boolean>(patternSegments.length + 1).fill(false);
    for (let patternIndex = 1; patternIndex <= patternSegments.length; patternIndex += 1) {
      const patternSegment = patternSegments[patternIndex - 1];
      if (patternSegment === "**") {
        current[patternIndex] = current[patternIndex - 1] || previous[patternIndex];
      } else {
        current[patternIndex] =
          previous[patternIndex - 1] && matchSegmentGlob(pathSegments[pathIndex - 1], patternSegment, cache);
      }
    }
    previous = current;
  }

  const result = previous[patternSegments.length];
  cache?.paths.set(cacheKey, result);
  return result;
}

/** True when `path` matches any precompiled ignore pattern. */
function isIgnoredByCompiledPatterns(
  path: string,
  patterns: readonly CompiledIgnorePattern[],
  cache = createGlobMatchCache()
): boolean {
  const normalized = normalizePath(path);
  if (!normalized) {
    return false;
  }
  const segments = normalized.split("/");

  for (const pattern of patterns) {
    if (pattern.kind === "segment") {
      if (segments.some((segment) => matchSegmentGlob(segment, pattern.pattern, cache))) {
        return true;
      }
    } else if (
      matchPathGlob(segments, pattern.segments, cache) ||
      matchPathGlob(segments, pattern.contentsSegments, cache)
    ) {
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
  const matchCache = createGlobMatchCache();

  for (const file of files) {
    if (isIgnoredByCompiledPatterns(file.path, compiledPatterns, matchCache)) {
      skipped.push({ path: file.path, reason: "ignored" });
    } else {
      kept.push(file);
    }
  }

  return { files: kept, skipped };
}
