import { describe, expect, it } from "vitest";
import { applyDiffLimits, describeSkipped } from "../src/review/size-guards.js";
import type { DiffFile, ParsedDiff } from "../src/review/diff-types.js";

function file(path: string, byteSize: number, binary = false): DiffFile {
  return { path, status: "modified", binary, hunks: [], byteSize };
}

const parsed: ParsedDiff = {
  files: [file("a.ts", 100), file("b.ts", 100), file("c.ts", 100), file("d.png", 50, true)]
};

describe("applyDiffLimits", () => {
  it("includes all text files and skips binaries when no caps are set", () => {
    const result = applyDiffLimits(parsed);
    expect(result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(result.skipped).toEqual([{ path: "d.png", reason: "binary" }]);
    expect(result.truncated).toBe(false);
  });

  it("enforces maxFiles and reports the overflow", () => {
    const result = applyDiffLimits(parsed, { maxFiles: 2 });
    expect(result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.skipped).toEqual([
      { path: "c.ts", reason: "maxFiles" },
      { path: "d.png", reason: "binary" }
    ]);
    expect(result.truncated).toBe(true);
  });

  it("enforces maxDiffBytes and reports the overflow", () => {
    const result = applyDiffLimits(parsed, { maxDiffBytes: 250 });
    expect(result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.skipped).toContainEqual({ path: "c.ts", reason: "maxDiffBytes" });
    expect(result.truncated).toBe(true);
  });

  it("never silently drops — every input file is either included or reported", () => {
    const result = applyDiffLimits(parsed, { maxFiles: 1 });
    const accountedFor = result.files.length + result.skipped.length;
    expect(accountedFor).toBe(parsed.files.length);
  });
});

describe("describeSkipped", () => {
  it("returns an empty string when nothing was skipped", () => {
    expect(describeSkipped([])).toBe("");
  });

  it("groups skipped files by reason", () => {
    const note = describeSkipped([
      { path: "c.ts", reason: "maxFiles" },
      { path: "d.png", reason: "binary" }
    ]);
    expect(note).toContain("c.ts");
    expect(note).toContain("d.png");
    expect(note).toContain("binary");
  });
});
