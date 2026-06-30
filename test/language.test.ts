import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  isJavaScriptFamily,
  isLanguageId,
  summarizeLanguages,
  LANGUAGES
} from "../src/review/language.js";

describe("detectLanguage (#5)", () => {
  it("detects common extensions", () => {
    expect(detectLanguage("src/a.ts")).toBe("typescript");
    expect(detectLanguage("ui/x.tsx")).toBe("typescript");
    expect(detectLanguage("lib/y.mjs")).toBe("javascript");
    expect(detectLanguage("svc/main.go")).toBe("go");
    expect(detectLanguage("app/models.py")).toBe("python");
    expect(detectLanguage("Cargo/lib.rs")).toBe("rust");
    expect(detectLanguage("Foo.java")).toBe("java");
    expect(detectLanguage("q.sql")).toBe("sql");
  });

  it("detects by exact filename when there is no telling extension", () => {
    expect(detectLanguage("Dockerfile")).toBe("docker");
    expect(detectLanguage("ops/Dockerfile")).toBe("docker");
    expect(detectLanguage("Makefile")).toBe("make");
  });

  it("is case-insensitive and tolerant of path style", () => {
    expect(detectLanguage("SRC\\A.TS")).toBe("typescript");
    expect(detectLanguage("deep/Nested/Path/file.PY")).toBe("python");
  });

  it("returns undefined for unknown extensions and dotfiles", () => {
    expect(detectLanguage("data.bin")).toBeUndefined();
    expect(detectLanguage("LICENSE")).toBeUndefined();
    expect(detectLanguage(".gitignore")).toBeUndefined(); // leading dot is not an extension
    expect(detectLanguage("noext")).toBeUndefined();
  });

  it("ignores inherited object keys in filename and extension lookups", () => {
    expect(detectLanguage("constructor")).toBeUndefined();
    expect(detectLanguage("src/foo.constructor")).toBeUndefined();
  });

  it("every mapped language id has a label", () => {
    // Guard against an extension pointing at an id missing from LANGUAGES.
    for (const id of ["typescript", "python", "go", "docker", "make"] as const) {
      expect(LANGUAGES[id]).toBeTruthy();
    }
  });
});

describe("isJavaScriptFamily (#5)", () => {
  it("is true only for JS/TS files", () => {
    expect(isJavaScriptFamily("a.ts")).toBe(true);
    expect(isJavaScriptFamily("a.cjs")).toBe(true);
    expect(isJavaScriptFamily("a.py")).toBe(false);
    expect(isJavaScriptFamily("Dockerfile")).toBe(false);
  });
});

describe("summarizeLanguages (#5)", () => {
  it("counts languages, most files first, omitting unknowns", () => {
    const summary = summarizeLanguages([
      "src/a.ts",
      "src/b.ts",
      "svc/main.go",
      "data.bin", // unknown → omitted
      "README" // no extension → omitted
    ]);
    expect(summary).toEqual([
      { id: "typescript", label: "TypeScript", files: 2 },
      { id: "go", label: "Go", files: 1 }
    ]);
  });

  it("breaks ties by label for stable ordering", () => {
    const summary = summarizeLanguages(["a.go", "b.py"]);
    expect(summary.map((l) => l.id)).toEqual(["go", "python"]); // Go < Python by label
  });

  it("returns [] when no files map to a known language", () => {
    expect(summarizeLanguages(["x.bin", "y"])).toEqual([]);
  });

  it("omits inherited object keys before stable sorting", () => {
    expect(summarizeLanguages(["a.go", "b.constructor"])).toEqual([{ id: "go", label: "Go", files: 1 }]);
  });
});

describe("isLanguageId (#5)", () => {
  it("accepts known language ids", () => {
    expect(isLanguageId("typescript")).toBe(true);
    expect(isLanguageId("python")).toBe(true);
    expect(isLanguageId("go")).toBe(true);
  });

  it("rejects unknown values and inherited keys", () => {
    expect(isLanguageId("klingon")).toBe(false);
    expect(isLanguageId("")).toBe(false);
    expect(isLanguageId("constructor")).toBe(false);
    expect(isLanguageId("hasOwnProperty")).toBe(false);
  });
});
