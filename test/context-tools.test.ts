import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRepoFiles,
  listRepoFilesDetailed,
  readRepoFile,
  searchRepo,
  findDefinition,
  findReferences,
  RepoAccessError,
  type ToolkitOptions
} from "../src/context/tools.js";

let root: string;
let outsideRoot: string;
let symlinksCreated = false;
let options: ToolkitOptions;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "prowl-tools-"));
  outsideRoot = mkdtempSync(join(tmpdir(), "prowl-tools-outside-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, ".prowl-review"));
  mkdirSync(join(root, "private"));
  writeFileSync(join(root, "src", "a.ts"), "export function foo() {}\ncallFoo();\n");
  writeFileSync(join(root, "src", "b.ts"), "import { foo } from './a';\nfoo();\n");
  writeFileSync(join(root, "node_modules", "ignored.ts"), "foo();\n");
  writeFileSync(join(root, ".prowl-review", "debug.jsonl"), "foo();\n");
  writeFileSync(join(root, "private", "secret.txt"), "private\n");
  writeFileSync(join(root, "big.txt"), "x".repeat(1000));
  writeFileSync(join(root, "long-line.txt"), `needle ${"a".repeat(2000)}\n`);
  writeFileSync(join(root, "oversized-match.txt"), `oversized-only\n${"x".repeat(1000)}`);
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x6f, 0x6f]));
  writeFileSync(join(outsideRoot, "secret.txt"), "outside secret\n");
  try {
    symlinkSync(join(outsideRoot, "secret.txt"), join(root, "src", "leak.txt"), "file");
    symlinkSync(outsideRoot, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    symlinksCreated = true;
  } catch {
    symlinksCreated = false;
  }
  options = { root, maxFileBytes: 500, maxMatches: 5 };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

describe("readRepoFile", () => {
  it("reads a file with a repo-relative path", () => {
    const result = readRepoFile(options, "src/a.ts");
    expect(result.path).toBe("src/a.ts");
    expect(result.content).toContain("export function foo");
    expect(result.truncated).toBe(false);
  });

  it("truncates files larger than the byte cap", () => {
    const result = readRepoFile(options, "big.txt");
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(500);
    expect(result.content).toHaveLength(500);
  });

  it("throws on a missing file", () => {
    expect(() => readRepoFile(options, "nope.ts")).toThrow(RepoAccessError);
  });

  it("rejects path traversal outside the repo root", () => {
    expect(() => readRepoFile(options, "../secret")).toThrow(/escapes repo root/);
    expect(() => readRepoFile(options, "/etc/passwd")).toThrow(/escapes repo root/);
  });

  it("rejects symlinked files and symlinked directory components", () => {
    if (!symlinksCreated) {
      return;
    }
    expect(() => readRepoFile(options, "src/leak.txt")).toThrow(/Symlinks are not allowed/);
    expect(() => readRepoFile(options, "linked/secret.txt")).toThrow(/Symlinks are not allowed/);
  });

  it("rejects files under ignored path segments", () => {
    expect(() => readRepoFile(options, "node_modules/ignored.ts")).toThrow(/ignored segment 'node_modules'/);
    expect(() => readRepoFile({ ...options, ignore: ["private"] }, "private/secret.txt")).toThrow(
      /ignored segment 'private'/
    );
  });
});

describe("listRepoFiles", () => {
  it("lists files and excludes ignored directories", () => {
    const files = listRepoFiles(options);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes(".prowl-review"))).toBe(false);
    expect(files.some((f) => f.includes("leak.txt"))).toBe(false);
  });

  it("caps returned files and reports truncation", () => {
    const result = listRepoFilesDetailed({ ...options, maxListedFiles: 2 });
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(listRepoFiles({ ...options, maxListedFiles: 2 })).toEqual(result.files);
  });

  it("rejects direct listings under ignored path segments", () => {
    expect(() => listRepoFiles(options, "node_modules")).toThrow(/ignored segment 'node_modules'/);
  });

  it("reports missing listing directories", () => {
    expect(() => listRepoFiles(options, "missing-dir")).toThrow(/Directory not found: missing-dir/);
  });
});

describe("searchRepo", () => {
  it("finds matches with line numbers and skips ignored dirs", () => {
    const result = searchRepo(options, "foo");
    const paths = result.matches.map((m) => m.path);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.includes(".prowl-review"))).toBe(false);
    const aMatch = result.matches.find((m) => m.path === "src/a.ts");
    expect(aMatch?.line).toBe(1);
  });

  it("caps matches and reports truncation", () => {
    const result = searchRepo({ ...options, maxMatches: 1 }, "foo");
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("applies the search file predicate before the match cap", () => {
    const result = searchRepo({ ...options, maxMatches: 1 }, "private|foo", ".", {
      shouldSearchFile: (path) => path !== "private/secret.txt"
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe("src/a.ts");
    expect(result.skippedFiles).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("caps visited files and reports truncation", () => {
    const result = searchRepo({ ...options, maxListedFiles: 1 }, "foo");
    expect(result.matches.length).toBeLessThanOrEqual(options.maxMatches ?? 5);
    expect(result.truncated).toBe(true);
  });

  it("skips binary files", () => {
    const result = searchRepo(options, "foo");
    expect(result.matches.some((m) => m.path === "bin.dat")).toBe(false);
  });

  it("skips files larger than the byte cap before searching", () => {
    const result = searchRepo(options, "oversized-only");
    expect(result.matches.some((m) => m.path === "oversized-match.txt")).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("caps long search match text and reports truncation", () => {
    const result = searchRepo(
      { ...options, maxFileBytes: 5000, maxMatchTextBytes: 20 },
      "needle"
    );
    const match = result.matches.find((m) => m.path === "long-line.txt");
    expect(match?.text).toMatch(/^needle a+/);
    expect(match?.text).toContain("...[truncated]");
    expect(match?.text.length).toBeLessThan(40);
    expect(result.truncated).toBe(true);
  });

  it("rejects direct searches under ignored path segments", () => {
    expect(() => searchRepo(options, "foo", "node_modules")).toThrow(/ignored segment 'node_modules'/);
  });

  it("reports missing search directories", () => {
    expect(() => searchRepo(options, "foo", "missing-dir")).toThrow(/Directory not found: missing-dir/);
  });

  it("throws on an invalid regex", () => {
    expect(() => searchRepo(options, "(")).toThrow(/Invalid search pattern/);
  });

  it("rejects unsafe regex patterns before searching", () => {
    expect(() => searchRepo(options, "(a+)+$")).toThrow(/Unsafe search pattern/);
  });

  it("rejects search patterns with too many unbounded repetitions", () => {
    expect(() => searchRepo(options, "a*a*a*a*a*b")).toThrow(/too many unbounded repetitions/);
  });
});

describe("findDefinition / findReferences (#5)", () => {
  let symRoot: string;
  let symOptions: ToolkitOptions;

  beforeAll(() => {
    symRoot = mkdtempSync(join(tmpdir(), "prowl-sym-"));
    mkdirSync(join(symRoot, "src"));
    mkdirSync(join(symRoot, "py"));
    mkdirSync(join(symRoot, "go"));
    // TS: definition + a separate call site.
    writeFileSync(join(symRoot, "src", "widget.ts"), "export function makeWidget() {\n  return 1;\n}\n");
    writeFileSync(join(symRoot, "src", "use.ts"), "import { makeWidget } from './widget';\nconst w = makeWidget();\n");
    // TS: assigned arrow function + class.
    writeFileSync(join(symRoot, "src", "store.ts"), "export const loadStore = () => ({});\nexport class Store {}\n");
    // Python def with the same name as a TS symbol (for language scoping).
    writeFileSync(join(symRoot, "py", "widget.py"), "def make_widget():\n    return 1\n\nmake_widget()\n");
    // Go receiver method.
    writeFileSync(join(symRoot, "go", "s.go"), "package s\n\nfunc (s *Server) Serve() error {\n\treturn nil\n}\n");
    symOptions = { root: symRoot };
  });

  afterAll(() => {
    rmSync(symRoot, { recursive: true, force: true });
  });

  it("locates a function definition, not its call site", () => {
    const result = findDefinition(symOptions, "makeWidget");
    expect(result.matches.some((m) => m.path === "src/widget.ts" && m.line === 1)).toBe(true);
    // The call site in use.ts is not a definition-shaped line.
    expect(result.matches.some((m) => m.path === "src/use.ts")).toBe(false);
  });

  it("locates an assigned arrow function and a class declaration", () => {
    expect(findDefinition(symOptions, "loadStore").matches.some((m) => m.path === "src/store.ts")).toBe(true);
    expect(findDefinition(symOptions, "Store").matches.some((m) => m.path === "src/store.ts")).toBe(true);
  });

  it("locates a Python def and a Go receiver method", () => {
    expect(findDefinition(symOptions, "make_widget").matches.some((m) => m.path === "py/widget.py")).toBe(true);
    expect(findDefinition(symOptions, "Serve").matches.some((m) => m.path === "go/s.go" && m.line === 3)).toBe(true);
  });

  it("restricts to a language when one is given", () => {
    const py = findDefinition(symOptions, "make_widget", { language: "python" });
    expect(py.matches.every((m) => m.path.endsWith(".py"))).toBe(true);
    const tsOnly = findDefinition(symOptions, "make_widget", { language: "typescript" });
    expect(tsOnly.matches).toHaveLength(0); // make_widget is only defined in Python
  });

  it("can scope to a subdirectory", () => {
    const result = findDefinition(symOptions, "make_widget", { dir: "src" });
    expect(result.matches).toHaveLength(0); // only defined under py/
  });

  it("returns no matches (without throwing) for an unknown symbol", () => {
    expect(findDefinition(symOptions, "doesNotExistAnywhere").matches).toHaveLength(0);
  });

  it("rejects an invalid symbol rather than building an unsafe pattern", () => {
    expect(() => findDefinition(symOptions, "a b")).toThrow(RepoAccessError);
    expect(() => findReferences(symOptions, "")).toThrow(RepoAccessError);
    expect(() => findDefinition(symOptions, "x".repeat(200))).toThrow(/exceeds/);
  });

  it("findReferences returns definition and call sites", () => {
    const result = findReferences(symOptions, "makeWidget");
    const paths = result.matches.map((m) => m.path);
    expect(paths).toContain("src/widget.ts"); // definition
    expect(paths).toContain("src/use.ts"); // import + call site
  });

  it("findReferences matches whole words only", () => {
    // "Store" must not match "loadStore" (no word boundary there) — but class Store does.
    const result = findReferences(symOptions, "Store");
    expect(result.matches.some((m) => m.text.includes("class Store"))).toBe(true);
    expect(result.matches.every((m) => !/loadStore/.test(m.text) || /\bStore\b/.test(m.text))).toBe(true);
  });
});
