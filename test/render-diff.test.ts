import { describe, expect, it } from "vitest";
import { renderGuardedDiff } from "../src/review/render-diff.js";
import type { DiffFile } from "../src/review/diff-types.js";

function modified(): DiffFile {
  return {
    path: "src/a.ts",
    status: "modified",
    binary: false,
    byteSize: 0,
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        section: "",
        lines: [
          { type: "context", content: "const a = 1;", oldLine: 1, newLine: 1 },
          { type: "add", content: "const b = 2;", newLine: 2 },
          { type: "del", content: "const old = 0;", oldLine: 2 },
          { type: "context", content: "const c = 3;", oldLine: 3, newLine: 3 }
        ]
      }
    ]
  };
}

describe("renderGuardedDiff", () => {
  it("annotates changed lines with new-side line numbers and markers", () => {
    const out = renderGuardedDiff([modified()]);
    expect(out).toContain("### src/a.ts (modified)");
    expect(out).toContain("@@ -1,2 +1,3 @@");
    expect(out).toContain("     2 +const b = 2;");
    expect(out).toContain("     1  const a = 1;");
    // deleted line carries a blank (no new-side) line number
    expect(out).toContain("       -const old = 0;");
  });

  it("notes binary files without body", () => {
    const out = renderGuardedDiff([
      { path: "img.png", status: "added", binary: true, byteSize: 0, hunks: [] }
    ]);
    expect(out).toContain("### img.png (added, binary — not shown)");
  });

  it("shows the rename arrow for renamed files", () => {
    const out = renderGuardedDiff([
      { path: "new.ts", oldPath: "old.ts", status: "renamed", binary: false, byteSize: 0, hunks: [] }
    ]);
    expect(out).toContain("### old.ts → new.ts (renamed)");
  });

  it("shows the copy source for copied files", () => {
    const out = renderGuardedDiff([
      { path: ".env.example", oldPath: "template.env", status: "copied", binary: false, byteSize: 0, hunks: [] }
    ]);
    expect(out).toContain("### template.env → .env.example (copied)");
  });

  it("returns an empty string for no files", () => {
    expect(renderGuardedDiff([])).toBe("");
  });
});
