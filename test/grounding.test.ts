import { describe, expect, it, vi } from "vitest";
import {
  gatherGrounding,
  parseEslintJson,
  buildGroundingSummary,
  type Exec,
  type ExecResult
} from "../src/grounding/index.js";

const ROOT = "/repo";

function eslintOutput(messages: Array<Record<string, unknown>>, filePath = "/repo/src/a.ts"): string {
  return JSON.stringify([{ filePath, messages }]);
}

function fakeExec(result: Partial<ExecResult>): Exec {
  return vi.fn(async () => ({ stdout: "", stderr: "", code: 0, ...result }));
}

describe("parseEslintJson", () => {
  it("maps error→minor and warning→info with relative paths", () => {
    const findings = parseEslintJson(
      ROOT,
      eslintOutput([
        { ruleId: "no-unused-vars", severity: 2, message: "'x' is unused", line: 5, endLine: 5 },
        { ruleId: "eqeqeq", severity: 1, message: "use ===", line: 9 }
      ])
    );
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      file: "src/a.ts",
      line: 5,
      severity: "minor",
      category: "lint",
      title: "no-unused-vars",
      confidence: 0.9
    });
    expect(findings[0].body).toContain("no-unused-vars");
    expect(findings[1]).toMatchObject({ severity: "info", title: "eqeqeq", line: 9 });
  });

  it("tolerates non-JSON / non-array output", () => {
    expect(parseEslintJson(ROOT, "")).toEqual([]);
    expect(parseEslintJson(ROOT, "command not found")).toEqual([]);
    expect(parseEslintJson(ROOT, "{}")).toEqual([]);
  });
});

describe("gatherGrounding", () => {
  it("lints only JS/TS changed files and returns findings + a note", async () => {
    const exec = fakeExec({ stdout: eslintOutput([{ ruleId: "no-debugger", severity: 2, message: "no debugger", line: 3 }]) });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts", "README.md", "data.json"],
      trustWorkspace: true,
      exec
    });

    // Only the .ts file is passed to eslint.
    const call = (exec as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toEqual(["--no-install", "eslint", "--format", "json", "--", "src/a.ts"]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("no-debugger");
    expect(result.notes.join(" ")).toContain("1 grounding finding");
  });

  it("skips entirely when no JS/TS files changed (no exec)", async () => {
    const exec = fakeExec({ stdout: "[]" });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["README.md"], exec });
    expect(exec).not.toHaveBeenCalled();
    expect(result.findings).toEqual([]);
  });

  it("skips repo-local ESLint unless the workspace is trusted", async () => {
    const exec = fakeExec({ stdout: eslintOutput([{ ruleId: "no-debugger", severity: 2, message: "no debugger", line: 3 }]) });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      exec
    });
    expect(exec).not.toHaveBeenCalled();
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("not trusted");
  });

  it("degrades gracefully when ESLint is not installed", async () => {
    const exec = fakeExec({ stdout: "", stderr: "npx: command not found", code: 127 });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["src/a.ts"], trustWorkspace: true, exec });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("ESLint not available");
  });

  it("surfaces installed-but-broken ESLint failures", async () => {
    const exec = fakeExec({ stdout: "", stderr: "Error: Cannot find module eslint.config.js", code: 2 });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["src/a.ts"], trustWorkspace: true, exec });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("ESLint failed (exit 2)");
    expect(result.notes.join(" ")).toContain("Cannot find module");
  });

  it("notes a timeout (code null) and skips", async () => {
    const exec = fakeExec({ code: null });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["src/a.ts"], trustWorkspace: true, exec });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("timed out");
  });

  it("caps findings and reports truncation", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ruleId: `r${i}`, severity: 2, message: "m", line: i + 1 }));
    const exec = fakeExec({ stdout: eslintOutput(many) });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      trustWorkspace: true,
      exec,
      limits: { maxFindings: 2 }
    });
    expect(result.findings).toHaveLength(2);
    expect(result.notes.join(" ")).toContain("kept 2/5");
  });

  it("caps files passed to ESLint and reports truncation", async () => {
    const manyFiles = ["a.ts", "b.ts", "c.ts"];
    const exec = fakeExec({ stdout: "[]" });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: manyFiles,
      trustWorkspace: true,
      exec,
      limits: { maxFiles: 2 }
    });
    expect((exec as ReturnType<typeof vi.fn>).mock.calls[0][1].slice(5)).toEqual(["a.ts", "b.ts"]);
    expect(result.notes.join(" ")).toContain("linted 2/3");
  });

  it("keeps only ESLint findings that overlap changed new-side lines", async () => {
    const exec = fakeExec({
      stdout: eslintOutput([
        { ruleId: "no-debugger", severity: 2, message: "no debugger", line: 3 },
        { ruleId: "eqeqeq", severity: 2, message: "use ===", line: 20 }
      ])
    });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      changedLines: { "src/a.ts": [3] },
      trustWorkspace: true,
      exec
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("no-debugger");
  });

  it("keeps multi-line ESLint findings that overlap changed new-side lines", async () => {
    const exec = fakeExec({
      stdout: eslintOutput([
        { ruleId: "multi-line-rule", severity: 2, message: "multi", line: 10, endLine: 12 },
        { ruleId: "non-overlap-rule", severity: 2, message: "non-overlap", line: 15, endLine: 17 }
      ])
    });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      changedLines: { "src/a.ts": [11, 20] },
      trustWorkspace: true,
      exec
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("multi-line-rule");
  });

  it("ignores changed paths that escape the workspace", async () => {
    const exec = fakeExec({ stdout: "[]" });
    await gatherGrounding({ root: ROOT, changedPaths: ["../outside.ts", "/etc/evil.ts"], trustWorkspace: true, exec });
    // Both escape → no JS/TS files in-workspace → exec never runs.
    expect(exec).not.toHaveBeenCalled();
  });

  it("handles an unexpected error in a runner", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      trustWorkspace: true,
      exec
    });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("Linter grounding error: ENOENT");
  });
});

describe("buildGroundingSummary", () => {
  it("renders a compact reconcile-don't-rediscover block", () => {
    const summary = buildGroundingSummary(parseEslintJson(ROOT, eslintOutput([
      { ruleId: "no-unused-vars", severity: 2, message: "'x' is unused", line: 5 }
    ])));
    expect(summary).toContain("Known linter findings");
    expect(summary).toContain("do not re-report");
    expect(summary).toContain("src/a.ts:5");
    expect(summary).toContain("no-unused-vars");
  });

  it("is empty when there are no findings", () => {
    expect(buildGroundingSummary([])).toBe("");
  });
});
