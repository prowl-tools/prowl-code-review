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
 * No glob dependency — the matcher is a small, auditable regex translation,
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

/** Translate a gitignore-lite glob into an anchored RegExp (no external dep). */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
        // Treat `**/` as "zero or more leading segments".
        if (glob[i + 1] === "/") {
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (char === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      re += `\\${char}`;
    } else {
      re += char;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Normalize a path to forward slashes with no leading `./` or trailing slash. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
}

/** True when `path` matches any ignore `patterns`. */
export function isIgnoredPath(path: string, patterns: readonly string[]): boolean {
  const normalized = normalizePath(path);
  if (!normalized) {
    return false;
  }
  const segments = normalized.split("/");

  for (const raw of patterns) {
    const pattern = normalizePath(raw.trim());
    if (!pattern) {
      continue;
    }
    if (pattern.includes("/")) {
      // Full-path glob, plus directory-prefix match for its contents.
      if (globToRegExp(pattern).test(normalized) || globToRegExp(`${pattern}/**`).test(normalized)) {
        return true;
      }
    } else {
      // Segment glob: match the pattern against any single path segment.
      const segmentRe = globToRegExp(pattern);
      if (segments.some((segment) => segmentRe.test(segment))) {
        return true;
      }
    }
  }
  return false;
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

  for (const file of files) {
    if (isIgnoredPath(file.path, patterns)) {
      skipped.push({ path: file.path, reason: "ignored" });
    } else {
      kept.push(file);
    }
  }

  return { files: kept, skipped };
}
