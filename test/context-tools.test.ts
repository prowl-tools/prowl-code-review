import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRepoFiles,
  readRepoFile,
  searchRepo,
  RepoAccessError,
  type ToolkitOptions
} from "../src/context/tools.js";

let root: string;
let options: ToolkitOptions;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "prowl-tools-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "src", "a.ts"), "export function foo() {}\ncallFoo();\n");
  writeFileSync(join(root, "src", "b.ts"), "import { foo } from './a';\nfoo();\n");
  writeFileSync(join(root, "node_modules", "ignored.ts"), "foo();\n");
  writeFileSync(join(root, "big.txt"), "x".repeat(1000));
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x6f, 0x6f]));
  options = { root, maxFileBytes: 500, maxMatches: 5 };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
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
});

describe("listRepoFiles", () => {
  it("lists files and excludes ignored directories", () => {
    const files = listRepoFiles(options);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });
});

describe("searchRepo", () => {
  it("finds matches with line numbers and skips ignored dirs", () => {
    const result = searchRepo(options, "foo");
    const paths = result.matches.map((m) => m.path);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    const aMatch = result.matches.find((m) => m.path === "src/a.ts");
    expect(aMatch?.line).toBe(1);
  });

  it("caps matches and reports truncation", () => {
    const result = searchRepo({ ...options, maxMatches: 1 }, "foo");
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("skips binary files", () => {
    const result = searchRepo(options, "foo");
    expect(result.matches.some((m) => m.path === "bin.dat")).toBe(false);
  });

  it("throws on an invalid regex", () => {
    expect(() => searchRepo(options, "(")).toThrow(/Invalid search pattern/);
  });
});
