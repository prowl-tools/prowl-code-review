import { describe, expect, it, vi } from "vitest";
import {
  gatherGrounding,
  parseEslintJson,
  parseOsvJson,
  parseSemgrepJson,
  dependencyScanTargets,
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

// --- Dependency-CVE / license scanning (#34) -------------------------------

const OSV_JSON = JSON.stringify({
  results: [
    {
      source: { path: "/repo/package-lock.json", type: "lockfile" },
      packages: [
        {
          package: { name: "lodash", version: "4.17.0", ecosystem: "npm" },
          vulnerabilities: [
            {
              id: "GHSA-jf85-cpcp-j695",
              aliases: ["CVE-2019-10744"],
              summary: "Prototype pollution in lodash",
              database_specific: { severity: "HIGH" },
              affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.12" }] }] }]
            }
          ],
          groups: [{ ids: ["GHSA-jf85-cpcp-j695"], max_severity: "7.5" }],
          licenses: ["MIT"]
        },
        {
          package: { name: "left-pad", version: "1.0.0", ecosystem: "npm" },
          vulnerabilities: [],
          licenses: ["MIT", "WTFPL"]
        }
      ]
    }
  ]
});

/** Exec mock that answers osv-scanner; everything else is a clean no-op. */
function execForOsv(osv: Partial<ExecResult>): Exec {
  return vi.fn(async (command: string): Promise<ExecResult> => {
    if (command === "osv-scanner") {
      return { stdout: "", stderr: "", code: 0, ...osv };
    }
    return { stdout: "", stderr: "", code: 0 };
  });
}

describe("dependencyScanTargets (#34)", () => {
  it("selects recognized lockfiles + requirements*.txt, ignoring source and deduping", () => {
    expect(
      dependencyScanTargets([
        "package-lock.json",
        "frontend/yarn.lock",
        "requirements-dev.txt",
        "go.mod",
        "src/app.ts",
        "package-lock.json"
      ])
    ).toEqual(["package-lock.json", "frontend/yarn.lock", "requirements-dev.txt", "go.mod"]);
  });

  it("rejects path traversal", () => {
    expect(dependencyScanTargets(["../evil/package-lock.json", "/abs/yarn.lock"])).toEqual([]);
  });
});

describe("parseOsvJson (#34)", () => {
  it("maps a vulnerability to a dependency finding with a relative path + CVE title", () => {
    const findings = parseOsvJson(ROOT, OSV_JSON);
    const vuln = findings.find((f) => f.title === "CVE-2019-10744");
    expect(vuln).toMatchObject({
      file: "package-lock.json",
      severity: "major", // HIGH
      category: "dependency",
      confidence: 0.9
    });
    expect(vuln?.line).toBeUndefined(); // file-level
    expect(vuln?.body).toContain("lodash@4.17.0");
    expect(vuln?.body).toContain("fixed in 4.17.12");
  });

  it("matches fixed versions to the reported package", () => {
    const json = JSON.stringify({
      results: [
        {
          source: { path: "/repo/package-lock.json" },
          packages: [
            {
              package: { name: "lodash", version: "4.17.0", ecosystem: "npm" },
              vulnerabilities: [
                {
                  id: "GHSA-shared",
                  aliases: ["CVE-2020-0001"],
                  affected: [
                    {
                      package: { name: "other", ecosystem: "npm" },
                      ranges: [{ events: [{ introduced: "0" }, { fixed: "9.9.9" }] }]
                    },
                    {
                      package: { name: "lodash", ecosystem: "npm" },
                      ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.12" }] }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    });

    const vuln = parseOsvJson(ROOT, json).find((f) => f.title === "CVE-2020-0001");
    expect(vuln?.body).toContain("fixed in 4.17.12");
    expect(vuln?.body).not.toContain("9.9.9");
  });

  it("does not emit license findings without an allowlist", () => {
    expect(parseOsvJson(ROOT, OSV_JSON).some((f) => f.title.startsWith("license-policy"))).toBe(false);
  });

  it("flags licenses outside the allowlist, leaving allowed ones alone", () => {
    const findings = parseOsvJson(ROOT, OSV_JSON, { allow: ["MIT", "Apache-2.0"] });
    const license = findings.filter((f) => f.title.startsWith("license-policy"));
    expect(license).toHaveLength(1);
    expect(license[0]).toMatchObject({ title: "license-policy: left-pad", severity: "major", category: "dependency" });
    expect(license[0].body).toContain("uses license WTFPL");
    expect(license[0].body).not.toContain("uses license MIT");
  });

  it("uses explicit OSV license violations before falling back to license comparison", () => {
    const json = JSON.stringify({
      results: [
        {
          source: { path: "/repo/package-lock.json" },
          packages: [
            {
              package: { name: "left-pad", version: "1.0.0", ecosystem: "npm" },
              vulnerabilities: [],
              license_violations: [{ license: { id: "GPL-3.0-only" } }]
            }
          ]
        }
      ]
    });

    const license = parseOsvJson(ROOT, json, { allow: ["MIT"] }).find((f) =>
      f.title.startsWith("license-policy")
    );
    expect(license?.body).toContain("GPL-3.0-only");
  });

  it("maps severity from a CVSS score when no GHSA label is present", () => {
    const json = JSON.stringify({
      results: [
        {
          source: { path: "/repo/go.mod" },
          packages: [
            {
              package: { name: "pkg", version: "1.0.0" },
              vulnerabilities: [{ id: "OSV-1" }],
              groups: [{ ids: ["OSV-1"], max_severity: "9.8" }]
            }
          ]
        }
      ]
    });
    expect(parseOsvJson(ROOT, json)[0].severity).toBe("critical");
  });

  it("tolerates non-JSON output", () => {
    expect(parseOsvJson(ROOT, "")).toEqual([]);
    expect(parseOsvJson(ROOT, "command not found")).toEqual([]);
  });
});

describe("dependency scanning via gatherGrounding (#34)", () => {
  it("scans changed lockfiles (from dependencyPaths, even if ignored from line-review)", async () => {
    const exec = execForOsv({ stdout: OSV_JSON, code: 1 }); // osv exits 1 when vulns found
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: [], // lockfile is ignored from line review
      dependencyPaths: ["package-lock.json"],
      exec
    });

    expect(result.findings.some((f) => f.category === "dependency" && f.title === "CVE-2019-10744")).toBe(true);
    const call = (exec as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "osv-scanner");
    expect(call?.[1]).toContain("-L");
    expect(call?.[1]).toContain("package-lock.json");
    expect(result.notes.join(" ")).toContain("dependency finding(s)");
  });

  it("passes the license flag and surfaces violations when an allowlist is set", async () => {
    const exec = execForOsv({ stdout: OSV_JSON, code: 1 });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: [],
      dependencyPaths: ["package-lock.json"],
      dependencyScan: { licenses: { allow: ["MIT", "Apache-2.0"] } },
      exec
    });
    expect(result.findings.some((f) => f.title === "license-policy: left-pad")).toBe(true);
    const call = (exec as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "osv-scanner");
    expect(call?.[1]).toContain("scan");
    expect(call?.[1].some((a) => a === "--licenses=MIT,Apache-2.0")).toBe(true);
    expect(call?.[1]).toContain("-L");
    expect(call?.[1]).toContain("package-lock.json");
    const configArg = call?.[1].find((a) => a.startsWith("--config="));
    expect(configArg).toBeDefined();
    expect(configArg).not.toContain(ROOT);
  });

  it("skips gracefully when osv-scanner is not installed", async () => {
    const exec = execForOsv({ stderr: "osv-scanner: command not found", code: 127 });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: [],
      dependencyPaths: ["package-lock.json"],
      exec
    });
    expect(result.findings).toHaveLength(0);
    expect(result.notes.join(" ")).toContain("osv-scanner not available");
  });

  it("skips gracefully when osv-scanner times out", async () => {
    const exec = execForOsv({ code: null });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: [],
      dependencyPaths: ["package-lock.json"],
      exec
    });
    expect(result.findings).toHaveLength(0);
    expect(result.notes.join(" ")).toContain("timed out");
  });

  it("treats osv-scanner v2 no-packages exit as a clean skip", async () => {
    const exec = execForOsv({ stderr: "No packages found", code: 128 });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: [],
      dependencyPaths: ["package-lock.json"],
      exec
    });
    expect(result.findings).toHaveLength(0);
    expect(result.notes.join(" ")).toContain("no packages found");
  });

  it("caps dependency scan targets before invoking osv-scanner", async () => {
    const exec = execForOsv({ stdout: "{\"results\":[]}", code: 0 });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: [],
      dependencyPaths: ["a/package-lock.json", "b/yarn.lock", "c/go.mod"],
      limits: { maxFiles: 2 },
      exec
    });
    const call = (exec as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "osv-scanner");
    expect(call?.[1].filter((arg) => arg === "-L")).toHaveLength(2);
    expect(call?.[1]).toContain("a/package-lock.json");
    expect(call?.[1]).toContain("b/yarn.lock");
    expect(call?.[1]).not.toContain("c/go.mod");
    expect(result.notes.join(" ")).toContain("scanning 2/3 lockfiles");
  });

  it("does not run osv-scanner when no dependency manifest changed", async () => {
    const exec = execForOsv({ stdout: OSV_JSON, code: 1 });
    await gatherGrounding({ root: ROOT, changedPaths: ["src/a.ts"], dependencyPaths: ["src/a.ts"], exec });
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "osv-scanner")).toBeUndefined();
  });

  it("does not run osv-scanner when dependency scanning is disabled", async () => {
    const exec = execForOsv({ stdout: OSV_JSON, code: 1 });
    await gatherGrounding({
      root: ROOT,
      changedPaths: [],
      dependencyPaths: ["package-lock.json"],
      dependencyScan: { enabled: false },
      exec
    });
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "osv-scanner")).toBeUndefined();
  });
});

/** Semgrep `--json` output with one result. */
function semgrepOutput(results: Array<Record<string, unknown>>): string {
  return JSON.stringify({ results, errors: [], paths: { scanned: [] } });
}

/** Arg-aware exec that answers the semgrep command (everything else: no findings). */
function execForSemgrep(result: Partial<ExecResult>): Exec {
  return vi.fn(async (command: string): Promise<ExecResult> => {
    const base = { stdout: command === "semgrep" ? "" : "[]", stderr: "", code: 0 };
    return command === "semgrep" ? { ...base, ...result } : base;
  });
}

const SEMGREP_RESULT = {
  check_id: "javascript.lang.security.audit.xss",
  path: "src/a.ts",
  start: { line: 3 },
  end: { line: 3 },
  extra: { message: "Possible XSS sink", severity: "ERROR", metadata: { category: "security" } }
};

describe("parseSemgrepJson", () => {
  it("maps a result to a security finding with severity/category", () => {
    const findings = parseSemgrepJson(ROOT, semgrepOutput([SEMGREP_RESULT]));
    expect(findings).toEqual([
      expect.objectContaining({
        file: "src/a.ts",
        line: 3,
        severity: "major",
        category: "security",
        title: "javascript.lang.security.audit.xss",
        confidence: 0.9
      })
    ]);
  });

  it("maps WARNING/INFO severities and non-security categories", () => {
    const findings = parseSemgrepJson(
      ROOT,
      semgrepOutput([
        { ...SEMGREP_RESULT, extra: { message: "perf", severity: "WARNING", metadata: { category: "performance" } } },
        { ...SEMGREP_RESULT, path: "src/b.ts", extra: { message: "style", severity: "INFO", metadata: { category: "best-practice" } } }
      ])
    );
    expect(findings[0]).toMatchObject({ severity: "minor", category: "performance" });
    expect(findings[1]).toMatchObject({ severity: "info", category: "lint" });
  });

  it("normalizes absolute paths and drops results without a line", () => {
    const findings = parseSemgrepJson(
      ROOT,
      semgrepOutput([
        { ...SEMGREP_RESULT, path: "/repo/src/c.ts" },
        { ...SEMGREP_RESULT, path: "src/d.ts", start: {} }
      ])
    );
    expect(findings).toEqual([expect.objectContaining({ file: "src/c.ts", line: 3 })]);
  });

  it("returns [] for non-JSON or a missing results array", () => {
    expect(parseSemgrepJson(ROOT, "not json")).toEqual([]);
    expect(parseSemgrepJson(ROOT, JSON.stringify({ errors: [] }))).toEqual([]);
  });
});

describe("gatherGrounding — Semgrep (#16b)", () => {
  it("scans changed source files ungated with the default registry pack", async () => {
    const exec = execForSemgrep({ stdout: semgrepOutput([SEMGREP_RESULT]), code: 1 });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts", "README.md"],
      changedLines: { "src/a.ts": [3] },
      exec // no trustWorkspace — registry ruleset runs ungated
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ file: "src/a.ts", line: 3, category: "security", title: SEMGREP_RESULT.check_id })
    );
    const call = (exec as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "semgrep");
    expect(call?.[1]).toEqual([
      "scan",
      "--json",
      "--quiet",
      "--metrics=off",
      "--disable-version-check",
      "--config=p/default",
      "--",
      "src/a.ts"
    ]);
    expect(call?.[3]).toMatchObject({ env: { SEMGREP_SEND_METRICS: "off" } });
    expect(result.notes.join(" ")).toContain("Semgrep: 1 SAST grounding finding");
  });

  it("does not invoke Semgrep when no supported source files changed", async () => {
    const exec = execForSemgrep({ stdout: semgrepOutput([SEMGREP_RESULT]), code: 1 });
    await gatherGrounding({ root: ROOT, changedPaths: ["docs/readme.md", "styles/x.css"], exec });
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "semgrep")).toBeUndefined();
  });

  it("drops Semgrep findings outside the changed lines", async () => {
    const exec = execForSemgrep({ stdout: semgrepOutput([SEMGREP_RESULT]), code: 1 });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      changedLines: { "src/a.ts": [99] },
      exec
    });
    expect(result.findings).toEqual([]);
  });

  it("skips gracefully when Semgrep is not installed", async () => {
    const exec = execForSemgrep({ stdout: "", code: 127 });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["src/a.ts"], exec });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("Semgrep not available");
  });

  it("surfaces a failure when an error exit yields no parseable report", async () => {
    const exec = execForSemgrep({ stdout: "", stderr: "could not fetch ruleset", code: 7 });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["src/a.ts"], exec });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("Semgrep failed (exit 7)");
  });

  it("surfaces a failure when Semgrep exits with findings but no parseable report", async () => {
    const exec = execForSemgrep({ stdout: "banner { not json", stderr: "", code: 1 });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["src/a.ts"], exec });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain("Semgrep failed (exit 1)");
  });

  it("notes when Semgrep times out", async () => {
    const exec = execForSemgrep({ stdout: "", code: null });
    const result = await gatherGrounding({ root: ROOT, changedPaths: ["src/a.ts"], exec });
    expect(result.notes.join(" ")).toContain("Semgrep: timed out; skipped.");
  });

  it("does not run Semgrep when disabled", async () => {
    const exec = execForSemgrep({ stdout: semgrepOutput([SEMGREP_RESULT]), code: 1 });
    await gatherGrounding({ root: ROOT, changedPaths: ["src/a.ts"], semgrep: { enabled: false }, exec });
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "semgrep")).toBeUndefined();
  });

  it("honors a registry ruleset override ungated", async () => {
    const exec = execForSemgrep({ stdout: semgrepOutput([]), code: 0 });
    await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      semgrep: { config: "p/security-audit" },
      exec
    });
    const call = (exec as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "semgrep");
    expect(call?.[1]).toContain("--config=p/security-audit");
  });

  it("skips a repo-path ruleset on an untrusted workspace", async () => {
    const exec = execForSemgrep({ stdout: semgrepOutput([SEMGREP_RESULT]), code: 1 });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      semgrep: { config: ".semgrep.yml" },
      exec
    });
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "semgrep")).toBeUndefined();
    expect(result.notes.join(" ")).toContain("requires a trusted workspace");
  });

  it("uses a repo-path ruleset when the workspace is trusted", async () => {
    const exec = execForSemgrep({ stdout: semgrepOutput([]), code: 0 });
    await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      trustWorkspace: true,
      semgrep: { config: ".semgrep.yml" },
      exec
    });
    const call = (exec as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "semgrep");
    expect(call?.[1]).toContain("--config=.semgrep.yml");
  });

  it("caps Semgrep findings and reports truncation", async () => {
    const many = Array.from({ length: 2 }, (_, i) => ({ ...SEMGREP_RESULT, path: "src/a.ts", start: { line: i + 1 } }));
    const exec = execForSemgrep({ stdout: semgrepOutput(many), code: 1 });
    const result = await gatherGrounding({
      root: ROOT,
      changedPaths: ["src/a.ts"],
      changedLines: { "src/a.ts": [1, 2] },
      limits: { maxFindings: 1 },
      exec
    });
    expect(result.findings).toHaveLength(1);
    expect(result.notes.join(" ")).toContain("Semgrep: kept 1/2 findings (finding cap).");
  });
});
