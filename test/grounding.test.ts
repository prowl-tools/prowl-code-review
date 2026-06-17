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

  it("normalizes mixed path separators", () => {
    const findings = parseEslintJson(
      ROOT,
      eslintOutput([{ ruleId: "mixed-path", severity: 2, message: "mixed path", line: 2 }], "src/foo\\bar.ts")
    );

    expect(findings[0].file).toBe("src/foo/bar.ts");
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
    expect(call[0]).toBe(process.execPath);
    expect(call[1]).toEqual([
      "--",
      "/repo/node_modules/eslint/bin/eslint.js",
      "--format",
      "json",
      "--no-error-on-unmatched-pattern",
      "--",
      "src/a.ts"
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("no-debugger");
    expect(result.notes.join(" ")).toContain("1 grounding finding");
  });

  it("does not run ESLint when no JS/TS files changed", async () => {
    const exec = fakeExec({ stdout: "[]" });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["README.md"], exec });
    // ESLint (process.execPath) isn't invoked; other ungated runners (e.g. Gitleaks) may be.
    const eslintCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === process.execPath);
    expect(eslintCalls).toHaveLength(0);
    expect(result.findings).toEqual([]);
  });

  it("skips repo-local ESLint unless the workspace is trusted", async () => {
    const exec = fakeExec({ stdout: eslintOutput([{ ruleId: "no-debugger", severity: 2, message: "no debugger", line: 3 }]) });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      exec
    });
    const eslintCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === process.execPath);
    expect(eslintCalls).toHaveLength(0); // ESLint gated behind trust; Gitleaks (ungated) may still run
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("not trusted");
  });

  it("degrades gracefully when ESLint is not installed", async () => {
    const exec = fakeExec({
      stdout: "",
      stderr: "Error: Cannot find module '/repo/node_modules/eslint/bin/eslint.js'",
      code: 1
    });
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
    expect((exec as ReturnType<typeof vi.fn>).mock.calls[0][1].slice(6)).toEqual(["a.ts", "b.ts"]);
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

  it("drops ESLint findings without line numbers when filtering to changed lines", async () => {
    const exec = fakeExec({
      stdout: eslintOutput([{ ruleId: "no-line", severity: 2, message: "no line info" }])
    });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      changedLines: { "src/a.ts": [1, 2, 3] },
      trustWorkspace: true,
      exec
    });
    expect(result.findings).toHaveLength(0);
  });

  it("drops ESLint findings in files with no changed lines", async () => {
    const exec = fakeExec({
      stdout: eslintOutput([{ ruleId: "some-rule", severity: 2, message: "msg", line: 5 }])
    });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      changedLines: { "src/a.ts": [] },
      trustWorkspace: true,
      exec
    });
    expect(result.findings).toHaveLength(0);
  });

  it("drops findings for files with no changed lines while keeping other files", async () => {
    const exec = fakeExec({
      stdout: JSON.stringify([
        {
          filePath: "/repo/src/a.ts",
          messages: [{ ruleId: "some-rule", severity: 2, message: "msg", line: 5 }]
        },
        {
          filePath: "/repo/src/b.ts",
          messages: [{ ruleId: "another-rule", severity: 2, message: "msg2", line: 10 }]
        }
      ])
    });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts", "src/b.ts"],
      changedLines: { "src/a.ts": [], "src/b.ts": [10] },
      trustWorkspace: true,
      exec
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe("src/b.ts");
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

/** Arg-aware exec: returns per-tool stdout/code keyed on the command. */
function execByTool(map: { ruff?: Partial<ExecResult>; gitleaks?: Partial<ExecResult> }): Exec {
  return vi.fn(async (command: string, _args: string[], _cwd: string, _options?: unknown): Promise<ExecResult> => {
    const base = { stdout: "[]", stderr: "", code: 0 };
    if (command === "ruff") return { ...base, ...map.ruff };
    if (command === "gitleaks") return { ...base, ...map.gitleaks };
    return base; // eslint / anything else: no findings
  });
}

describe("gatherGrounding — Ruff (#16b)", () => {
  const ruffJson = JSON.stringify([
    { code: "F401", message: "`os` imported but unused", filename: "app/x.py", location: { row: 3 }, end_location: { row: 3 } }
  ]);

  it("lints changed Python files, ungated, on changed lines", async () => {
    const exec = execByTool({ ruff: { stdout: ruffJson, code: 1 } }); // ruff exits 1 when violations exist
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["app/x.py", "README.md"],
      changedLines: { "app/x.py": [3] },
      exec // note: no trustWorkspace — Ruff runs ungated
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ file: "app/x.py", line: 3, category: "lint", title: "F401", severity: "minor" })
    );
    const ruffCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === "ruff");
    expect(ruffCall?.[1]).toEqual(["check", "--output-format", "json", "--isolated", "--no-cache", "--", "app/x.py"]);
    expect(ruffCall?.[1]).not.toContain("--force-exclude");
    expect(result.notes.join(" ")).toContain("Ruff: 1 grounding finding");
  });

  it("does not invoke Ruff when no Python files changed", async () => {
    const exec = execByTool({ ruff: { stdout: ruffJson, code: 1 } });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["README.md"], exec });
    const ruffCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === "ruff");
    expect(ruffCalls).toHaveLength(0);
    expect(result.findings).toEqual([]);
  });

  it("caps Ruff files and reports truncation", async () => {
    const exec = execByTool({ ruff: { stdout: "[]", code: 0 } });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["app/a.py", "app/b.py"],
      exec,
      limits: { maxFiles: 1 }
    });

    const ruffCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === "ruff");
    expect(ruffCall?.[1]).toEqual(["check", "--output-format", "json", "--isolated", "--no-cache", "--", "app/a.py"]);
    expect(result.notes.join(" ")).toContain("Ruff: linted 1/2 changed files (file cap).");
  });

  it("drops Ruff findings outside the changed lines", async () => {
    const exec = execByTool({ ruff: { stdout: ruffJson, code: 1 } });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["app/x.py"],
      changedLines: { "app/x.py": [99] },
      exec
    });
    expect(result.findings).toEqual([]);
  });

  it("skips gracefully when Ruff is not installed", async () => {
    const exec = execByTool({ ruff: { stdout: "", code: 127 } });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["app/x.py"], exec });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("Ruff not available");
  });

  it("notes when Ruff times out", async () => {
    const exec = execByTool({ ruff: { stdout: "", code: null } });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["app/x.py"], exec });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("Ruff: timed out; skipped.");
  });

  it("caps Ruff findings and reports truncation", async () => {
    const manyRuffJson = JSON.stringify([
      { code: "F401", message: "`os` imported but unused", filename: "app/a.py", location: { row: 1 }, end_location: { row: 1 } },
      { code: "F841", message: "local variable is assigned to but never used", filename: "app/b.py", location: { row: 2 }, end_location: { row: 2 } }
    ]);
    const exec = execByTool({ ruff: { stdout: manyRuffJson, code: 1 } });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["app/a.py", "app/b.py"],
      changedLines: { "app/a.py": [1], "app/b.py": [2] },
      exec,
      limits: { maxFindings: 1 }
    });

    expect(result.findings).toHaveLength(1);
    expect(result.notes.join(" ")).toContain("Ruff: kept 1/2 findings (finding cap).");
  });

  it("notes malformed Ruff JSON when violations exit with no parseable findings", async () => {
    const exec = execByTool({ ruff: { stdout: "[", stderr: "truncated json", code: 1 } });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["app/x.py"], exec });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("Ruff failed (exit 1)");
    expect(result.notes.join(" ")).toContain("truncated json");
  });
});

describe("gatherGrounding — Gitleaks (#16b)", () => {
  const gitleaksJson = JSON.stringify([
    { RuleID: "generic-api-key", Description: "Detected a Generic API Key", File: "config.py", StartLine: 5, EndLine: 5 }
  ]);

  it("flags secrets on changed lines as critical security findings, ungated", async () => {
    const exec = execByTool({ gitleaks: { stdout: gitleaksJson, code: 1 } }); // gitleaks exits 1 when leaks found
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["config.py"],
      changedLines: { "config.py": [5] },
      exec // no trustWorkspace — Gitleaks runs ungated
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ file: "config.py", line: 5, severity: "critical", category: "security", title: "generic-api-key" })
    );
    const gitleaksCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === "gitleaks");
    expect(gitleaksCall?.[1]).toEqual([
      "detect",
      "--no-git",
      "--source",
      "config.py",
      "--report-format",
      "json",
      "--report-path",
      "-",
      "--redact",
      "--no-banner",
      "--ignore-gitleaks-allow",
      "--gitleaks-ignore-path",
      expect.any(String)
    ]);
    expect(gitleaksCall?.[1]).not.toContain("/dev/stdout");
    expect(gitleaksCall?.[3]).toMatchObject({ env: { GITLEAKS_CONFIG: "", GITLEAKS_CONFIG_TOML: "" } });
    expect(result.notes.join(" ")).toContain("Gitleaks: 1 potential secret");
  });

  it("scans secret-only paths with Gitleaks", async () => {
    const secretJson = JSON.stringify([
      { RuleID: "generic-api-key", Description: "Detected a Generic API Key", File: ".env", StartLine: 1, EndLine: 1 }
    ]);
    const exec = execByTool({ gitleaks: { stdout: secretJson, code: 1 } });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: [],
      secretScanPaths: [".env"],
      changedLines: { ".env": [1] },
      exec
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ file: ".env", line: 1, severity: "critical", category: "security" })
    );
    const gitleaksCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === "gitleaks");
    expect(gitleaksCalls).toHaveLength(1);
    expect(gitleaksCalls[0][1]).toContain(".env");
    const ruffCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === "ruff");
    expect(ruffCalls).toHaveLength(0);
  });

  it("keeps Gitleaks findings for whole-file secret scan paths without changed lines", async () => {
    const secretJson = JSON.stringify([
      {
        RuleID: "generic-api-key",
        Description: "Detected a Generic API Key",
        File: "config/example.txt",
        StartLine: 7,
        EndLine: 7
      }
    ]);
    const exec = execByTool({ gitleaks: { stdout: secretJson, code: 1 } });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: [],
      secretScanPaths: ["config/example.txt"],
      secretScanWholeFilePaths: ["config/example.txt"],
      changedLines: {},
      exec
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ file: "config/example.txt", line: 7, severity: "critical", category: "security" })
    );
  });

  it("prioritizes secret-only paths before applying the Gitleaks file cap", async () => {
    const exec = execByTool({ gitleaks: { stdout: "[]", code: 0 } });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts", "src/b.ts"],
      secretScanPaths: [".env"],
      exec,
      limits: { maxFiles: 2 }
    });

    const sources = (exec as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === "gitleaks")
      .map((call) => call[1][call[1].indexOf("--source") + 1]);
    expect(sources).toEqual([".env", "src/a.ts"]);
    expect(result.notes.join(" ")).toContain("scanned 2/3");
  });

  it("does not invoke Gitleaks when there are no safe changed paths", async () => {
    const exec = execByTool({ gitleaks: { stdout: gitleaksJson, code: 1 } });
    const result = await gatherGrounding({ root: ROOT, changedPaths: [], exec });
    const gitleaksCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === "gitleaks");
    expect(gitleaksCalls).toHaveLength(0);
    expect(result.findings).toEqual([]);
  });

  it("drops leaks outside the changed lines", async () => {
    const exec = execByTool({ gitleaks: { stdout: gitleaksJson, code: 1 } });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["config.py"],
      changedLines: { "config.py": [1] },
      exec
    });
    expect(result.findings).toEqual([]);
  });

  it("skips gracefully when Gitleaks is not installed", async () => {
    const exec = execByTool({ gitleaks: { stdout: "", code: 127 } });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["config.py"], exec });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("Gitleaks not available");
  });

  it("keeps Gitleaks findings from valid files when another source is missing", async () => {
    const exec: Exec = vi.fn(async (command: string, args: string[], _cwd: string, _options?: unknown): Promise<ExecResult> => {
      if (command !== "gitleaks") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      const source = args[args.indexOf("--source") + 1];
      if (source === "deleted.env") {
        return { stdout: "", stderr: "stat deleted.env: no such file or directory", code: 1 };
      }
      return { stdout: gitleaksJson, stderr: "", code: 1 };
    });

    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["deleted.env", "config.py"],
      changedLines: { "config.py": [5] },
      exec
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ file: "config.py", line: 5, severity: "critical", category: "security" })
    );
    expect(result.notes.join(" ")).toContain("Gitleaks failed (exit 1)");
    expect(result.notes.join(" ")).toContain("no such file or directory");
  });

  it("keeps Gitleaks findings from valid files when another source times out", async () => {
    const exec: Exec = vi.fn(async (command: string, args: string[], _cwd: string, _options?: unknown): Promise<ExecResult> => {
      if (command !== "gitleaks") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      const source = args[args.indexOf("--source") + 1];
      if (source === "slow.env") {
        return { stdout: "", stderr: "", code: null };
      }
      return { stdout: gitleaksJson, stderr: "", code: 1 };
    });

    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["slow.env", "config.py"],
      changedLines: { "config.py": [5] },
      exec
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ file: "config.py", line: 5, severity: "critical", category: "security" })
    );
    expect(result.notes.join(" ")).toContain("Gitleaks: timed out; skipped.");
  });

  it("notes malformed Gitleaks JSON when leaks exit with no parseable findings", async () => {
    const exec = execByTool({ gitleaks: { stdout: "[", stderr: "truncated json", code: 1 } });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["config.py"], exec });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("Gitleaks failed (exit 1)");
    expect(result.notes.join(" ")).toContain("truncated json");
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
