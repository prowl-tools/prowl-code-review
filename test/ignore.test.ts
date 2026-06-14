import { describe, expect, it } from "vitest";
import { DEFAULT_IGNORE_GLOBS, isIgnoredPath, filterIgnoredDiffFiles } from "../src/review/ignore.js";
import type { DiffFile } from "../src/review/diff-types.js";

function file(path: string): DiffFile {
  return { path, status: "modified", binary: false, byteSize: 10, hunks: [] };
}

describe("isIgnoredPath", () => {
  it("matches directory segments anywhere in the path", () => {
    expect(isIgnoredPath("node_modules/left-pad/index.js", DEFAULT_IGNORE_GLOBS)).toBe(true);
    expect(isIgnoredPath("packages/app/dist/cli.js", DEFAULT_IGNORE_GLOBS)).toBe(true);
    expect(isIgnoredPath("vendor/github.com/x/y.go", DEFAULT_IGNORE_GLOBS)).toBe(true);
  });

  it("matches lockfiles by basename", () => {
    expect(isIgnoredPath("package-lock.json", DEFAULT_IGNORE_GLOBS)).toBe(true);
    expect(isIgnoredPath("services/api/go.sum", DEFAULT_IGNORE_GLOBS)).toBe(true);
    expect(isIgnoredPath("pnpm-lock.yaml", DEFAULT_IGNORE_GLOBS)).toBe(true);
  });

  it("matches snapshot files and directories", () => {
    expect(isIgnoredPath("src/__snapshots__/x.ts.snap", DEFAULT_IGNORE_GLOBS)).toBe(true);
    expect(isIgnoredPath("test/foo.snap", DEFAULT_IGNORE_GLOBS)).toBe(true);
  });

  it("does not match ordinary source files", () => {
    expect(isIgnoredPath("src/index.ts", DEFAULT_IGNORE_GLOBS)).toBe(false);
    expect(isIgnoredPath("src/distance.ts", DEFAULT_IGNORE_GLOBS)).toBe(false); // not the `dist` segment
    expect(isIgnoredPath("README.md", DEFAULT_IGNORE_GLOBS)).toBe(false);
  });

  it("supports `*` (within a segment) and `**` (across segments) globs", () => {
    expect(isIgnoredPath("a/b/c.min.js", ["*.min.js"])).toBe(true);
    expect(isIgnoredPath("src/generated/api.ts", ["src/generated/**"])).toBe(true);
    expect(isIgnoredPath("src/handcrafted/api.ts", ["src/generated/**"])).toBe(false);
    expect(isIgnoredPath("docs/api/v1/spec.json", ["docs/**/spec.json"])).toBe(true);
  });

  it("does not match a path segment partially without a glob", () => {
    expect(isIgnoredPath("my-node_modules-helper/x.ts", ["node_modules"])).toBe(false);
  });

  it("matches nothing when the pattern list is empty", () => {
    expect(isIgnoredPath("node_modules/x.js", [])).toBe(false);
  });
});

describe("filterIgnoredDiffFiles", () => {
  it("splits kept files from ignored ones and reports the skips", () => {
    const files = [file("src/a.ts"), file("dist/a.js"), file("package-lock.json"), file("src/b.ts")];
    const { files: kept, skipped } = filterIgnoredDiffFiles(files, DEFAULT_IGNORE_GLOBS);

    expect(kept.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(skipped).toEqual([
      { path: "dist/a.js", reason: "ignored" },
      { path: "package-lock.json", reason: "ignored" }
    ]);
  });

  it("never silently drops — every file is kept or reported", () => {
    const files = [file("src/a.ts"), file("dist/a.js"), file("node_modules/x/y.js")];
    const { files: kept, skipped } = filterIgnoredDiffFiles(files, DEFAULT_IGNORE_GLOBS);
    expect(kept.length + skipped.length).toBe(files.length);
  });

  it("ignores nothing when given an empty pattern list", () => {
    const files = [file("dist/a.js"), file("package-lock.json")];
    const { files: kept, skipped } = filterIgnoredDiffFiles(files, []);
    expect(kept).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });
});
