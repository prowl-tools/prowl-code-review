import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/review/parse-diff.js";

const MODIFIED = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@ function foo()
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
@@ -10,2 +11,2 @@
 x();
-y();
+z();
`;

const ADDED = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;

const DELETED = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index abc1234..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-now
`;

const RENAMED = `diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts
index abc1234..def5678 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -1 +1 @@
-old
+new
`;

const COPIED = `diff --git a/template.env b/.env.example
similarity index 100%
copy from template.env
copy to .env.example
`;

const BINARY = `diff --git a/img.png b/img.png
new file mode 100644
index 0000000..abc1234
Binary files /dev/null and b/img.png differ
`;

describe("parseDiff", () => {
  it("parses a modified file with multiple hunks and line numbers", () => {
    const { files } = parseDiff(MODIFIED);
    expect(files).toHaveLength(1);
    const file = files[0];
    expect(file.path).toBe("src/foo.ts");
    expect(file.status).toBe("modified");
    expect(file.binary).toBe(false);
    expect(file.hunks).toHaveLength(2);

    const h1 = file.hunks[0];
    expect(h1.section).toBe("function foo()");
    expect(h1.oldStart).toBe(1);
    expect(h1.newStart).toBe(1);
    expect(h1.lines[0]).toEqual({ type: "context", content: "const a = 1;", oldLine: 1, newLine: 1 });
    expect(h1.lines[1]).toEqual({ type: "del", content: "const b = 2;", oldLine: 2 });
    expect(h1.lines[2]).toEqual({ type: "add", content: "const b = 3;", newLine: 2 });
    expect(h1.lines[3]).toEqual({ type: "add", content: "const c = 4;", newLine: 3 });
    expect(h1.lines[4]).toEqual({ type: "context", content: "const d = 5;", oldLine: 3, newLine: 4 });

    const h2 = file.hunks[1];
    expect(h2.newStart).toBe(11);
    expect(h2.lines[2]).toEqual({ type: "add", content: "z();", newLine: 12 });
  });

  it("parses an added file", () => {
    const { files } = parseDiff(ADDED);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe("added");
    expect(files[0].path).toBe("new.txt");
    expect(files[0].hunks[0].lines).toEqual([
      { type: "add", content: "hello", newLine: 1 },
      { type: "add", content: "world", newLine: 2 }
    ]);
  });

  it("parses a deleted file (path is the removed path)", () => {
    const { files } = parseDiff(DELETED);
    expect(files[0].status).toBe("deleted");
    expect(files[0].path).toBe("gone.txt");
    expect(files[0].hunks[0].lines).toEqual([
      { type: "del", content: "bye", oldLine: 1 },
      { type: "del", content: "now", oldLine: 2 }
    ]);
  });

  it("parses a renamed file", () => {
    const { files } = parseDiff(RENAMED);
    expect(files[0].status).toBe("renamed");
    expect(files[0].oldPath).toBe("old-name.ts");
    expect(files[0].path).toBe("new-name.ts");
  });

  it("parses a copied file", () => {
    const { files } = parseDiff(COPIED);
    expect(files[0].status).toBe("copied");
    expect(files[0].oldPath).toBe("template.env");
    expect(files[0].path).toBe(".env.example");
    expect(files[0].hunks).toHaveLength(0);
  });

  it("flags binary files with no hunks", () => {
    const { files } = parseDiff(BINARY);
    expect(files[0].binary).toBe(true);
    expect(files[0].path).toBe("img.png");
    expect(files[0].hunks).toHaveLength(0);
  });

  it("parses multiple files in one diff", () => {
    const { files } = parseDiff(MODIFIED + ADDED + BINARY);
    expect(files.map((f) => f.path)).toEqual(["src/foo.ts", "new.txt", "img.png"]);
    expect(files.map((f) => f.status)).toEqual(["modified", "added", "added"]);
  });

  it("ignores the no-newline marker without disturbing line counts", () => {
    const withMarker = `diff --git a/n.txt b/n.txt
--- a/n.txt
+++ b/n.txt
@@ -1,2 +1,2 @@
 keep
-old
+new
\\ No newline at end of file
`;
    const { files } = parseDiff(withMarker);
    const lines = files[0].hunks[0].lines;
    expect(lines).toEqual([
      { type: "context", content: "keep", oldLine: 1, newLine: 1 },
      { type: "del", content: "old", oldLine: 2 },
      { type: "add", content: "new", newLine: 2 }
    ]);
  });

  it("parses hunk content that looks like file headers", () => {
    const headerLikeContent = `diff --git a/header.txt b/header.txt
--- a/header.txt
+++ b/header.txt
@@ -1,2 +1,2 @@
--- removed marker
+++ added marker
`;

    const { files } = parseDiff(headerLikeContent);

    expect(files[0].path).toBe("header.txt");
    expect(files[0].oldPath).toBe("header.txt");
    expect(files[0].hunks[0].lines).toEqual([
      { type: "del", content: "-- removed marker", oldLine: 1 },
      { type: "add", content: "++ added marker", newLine: 1 }
    ]);
  });

  it("decodes git-quoted paths before storing file paths", () => {
    const quotedPath = String.raw`diff --git "a/\303\251\011file.txt" "b/\303\251\011file.txt"
--- "a/\303\251\011file.txt"
+++ "b/\303\251\011file.txt"
@@ -1 +1 @@
-old
+new
`;

    const { files } = parseDiff(quotedPath);

    expect(files[0].path).toBe("é\tfile.txt");
    expect(files[0].oldPath).toBe("é\tfile.txt");
  });

  it("preserves decoded diff-git paths with trailing spaces", () => {
    const pathWithTrailingSpace = "trailing-space.txt ";
    const quotedPath = `diff --git "a/${pathWithTrailingSpace}" "b/${pathWithTrailingSpace}"
Binary files "a/${pathWithTrailingSpace}" and "b/${pathWithTrailingSpace}" differ
`;

    const { files } = parseDiff(quotedPath);

    expect(files[0].path).toBe(pathWithTrailingSpace);
    expect(files[0].binary).toBe(true);
  });

  it("preserves unquoted diff-git paths with spaces", () => {
    const diffWithSpaces = `diff --git a/space file.bin b/space file.bin
Binary files a/space file.bin and b/space file.bin differ
`;

    const { files } = parseDiff(diffWithSpaces);

    expect(files[0].path).toBe("space file.bin");
    expect(files[0].binary).toBe(true);
  });

  it("preserves unquoted diff-git paths with embedded b components", () => {
    const pathWithMarker = "foo b/bar.bin";
    const diffWithEmbeddedMarker = `diff --git a/${pathWithMarker} b/${pathWithMarker}
Binary files a/${pathWithMarker} and b/${pathWithMarker} differ
`;

    const { files } = parseDiff(diffWithEmbeddedMarker);

    expect(files[0].path).toBe(pathWithMarker);
    expect(files[0].binary).toBe(true);
  });

  it("records a byte size per file", () => {
    const { files } = parseDiff(ADDED);
    expect(files[0].byteSize).toBe(Buffer.byteLength(ADDED, "utf8"));
  });

  it("computes byteSize correctly when the final line has no trailing newline", () => {
    const noTrailingNewline = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

    const { files } = parseDiff(noTrailingNewline);

    expect(files[0].byteSize).toBe(Buffer.byteLength(noTrailingNewline, "utf8"));
  });

  it("computes byteSize using UTF-8 bytes for multibyte diff content", () => {
    const multibyte = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+新しい🚀\n";

    const { files } = parseDiff(multibyte);

    expect(files[0].byteSize).toBe(Buffer.byteLength(multibyte, "utf8"));
    expect(files[0].byteSize).toBeGreaterThan(multibyte.length);
  });

  it("returns no files for an empty diff", () => {
    expect(parseDiff("").files).toEqual([]);
  });
});
