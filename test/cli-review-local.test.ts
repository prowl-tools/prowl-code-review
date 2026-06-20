import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runLocalReview,
  resolveColor,
  meetsFailThreshold,
  type LocalReviewDeps
} from "../src/cli/commands/review-local.js";
import { emptyUsage } from "../src/providers/index.js";
import type { Finding } from "../src/review/findings.js";
import type { ReviewResult } from "../src/review/run-review.js";

const ORIGINAL_ENV = process.env;
let tempDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = ORIGINAL_ENV;
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

/** An isolated workspace so guidelines/config aren't loaded from the real repo. */
function isolatedWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "prowl-local-"));
  tempDirs.push(dir);
  process.env.PROWL_WORKSPACE = dir;
  return dir;
}

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 const z = 3;
`;

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: 2,
    severity: "major",
    category: "correctness",
    title: "Bug here",
    body: "Explanation.",
    confidence: 0.8,
    ...over
  };
}

function reviewResult(over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    findings: [],
    uncappedFindings: [],
    raw: [],
    passes: [],
    verification: { verified: 0, droppedFalsePositive: 0, demoted: 0, unverified: 0, ok: true },
    judge: { duplicatesRemoved: 0, belowThreshold: 0, belowConfidence: 0, capped: 0 },
    usage: emptyUsage(),
    ...over
  };
}

/** Build injected deps with capturing out/err sinks and stubbed heavy stages. */
function deps(over: Partial<LocalReviewDeps> = {}): {
  deps: LocalReviewDeps;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      env: { PROWL_AI_KEY: "test-key" },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      resolveHead: vi.fn().mockResolvedValue(undefined),
      resolveDiff: vi.fn().mockResolvedValue(DIFF),
      gatherContext: vi.fn().mockResolvedValue({ files: [], notes: [], usage: emptyUsage() }),
      gatherGrounding: vi.fn().mockResolvedValue({ findings: [], notes: [] }),
      runReview: vi.fn().mockResolvedValue(reviewResult({ findings: [finding()] })),
      ...over
    }
  };
}

describe("runLocalReview (#35)", () => {
  it("reviews the local diff and prints findings to the terminal", async () => {
    isolatedWorkspace();
    const { deps: d, out } = deps();
    const result = await runLocalReview({ base: "main", config: false }, d);

    expect(result.findings).toHaveLength(1);
    const report = out.join("\n");
    expect(report).toContain("prowl-review (local)");
    expect(report).toContain("[MAJOR]");
    expect(report).toContain("src/a.ts:2");
    expect(d.runReview).toHaveBeenCalledTimes(1);
  });

  it("reports no changes without calling the review engine", async () => {
    isolatedWorkspace();
    const { deps: d, out } = deps({ resolveDiff: vi.fn().mockResolvedValue("") });
    const result = await runLocalReview({ base: "main", config: false }, d);

    expect(result.findings).toHaveLength(0);
    expect(out.join("\n")).toContain("No changes to review");
    expect(d.runReview).not.toHaveBeenCalled();
  });

  it("emits JSON when --json is set", async () => {
    isolatedWorkspace();
    const { deps: d, out } = deps();
    await runLocalReview({ base: "main", config: false, json: true }, d);

    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.summary.total).toBe(1);
    expect(parsed.findings[0].file).toBe("src/a.ts");
  });

  it("passes the merge-base diff through git ref resolution", async () => {
    isolatedWorkspace();
    const resolveHead = vi.fn().mockResolvedValue(undefined);
    const resolveDiff = vi.fn().mockResolvedValue(DIFF);
    const { deps: d } = deps({ resolveHead, resolveDiff });
    await runLocalReview({ base: "develop", head: "feature", config: false }, d);
    expect(resolveHead).toHaveBeenCalledWith(expect.objectContaining({ head: "feature" }));
    expect(resolveDiff).toHaveBeenCalledWith(expect.objectContaining({ base: "develop", head: "feature" }));
  });

  it("defaults the base to main when none is given", async () => {
    isolatedWorkspace();
    const resolveDiff = vi.fn().mockResolvedValue(DIFF);
    const { deps: d } = deps({ resolveDiff });
    await runLocalReview({ head: "feature", config: false }, d);
    expect(resolveDiff).toHaveBeenCalledWith(expect.objectContaining({ base: "main" }));
  });

  it("uses injected env for workspace resolution", async () => {
    const processRoot = isolatedWorkspace();
    const injectedRoot = mkdtempSync(join(tmpdir(), "prowl-local-injected-"));
    tempDirs.push(injectedRoot);
    process.env.PROWL_WORKSPACE = processRoot;
    const resolveDiff = vi.fn().mockResolvedValue(DIFF);
    const { deps: d } = deps({
      env: { PROWL_AI_KEY: "test-key", PROWL_WORKSPACE: injectedRoot },
      resolveDiff
    });

    await runLocalReview({ base: "main", config: false }, d);

    expect(resolveDiff).toHaveBeenCalledWith(expect.objectContaining({ cwd: injectedRoot }));
    expect(d.gatherContext).toHaveBeenCalledWith(expect.objectContaining({ toolkit: { root: injectedRoot } }));
  });

  it("feeds grounding findings into the review and surfaces grounding notes", async () => {
    isolatedWorkspace();
    const gatherGrounding = vi.fn().mockResolvedValue({
      findings: [finding({ category: "lint", title: "no-unused-vars" })],
      notes: ["ran eslint"]
    });
    const runReview = vi.fn().mockResolvedValue(reviewResult({ findings: [finding()] }));
    const { deps: d, out } = deps({ gatherGrounding, runReview });
    await runLocalReview({ base: "main", config: false }, d);

    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({ grounding: expect.objectContaining({ findings: expect.any(Array) }) }),
      expect.anything()
    );
    expect(out.join("\n")).toContain("Linter grounding: ran eslint");
  });

  it("skips context and grounding when disabled", async () => {
    isolatedWorkspace();
    const { deps: d } = deps();
    await runLocalReview({ base: "main", config: false, context: false, grounding: false }, d);
    expect(d.gatherContext).not.toHaveBeenCalled();
    expect(d.gatherGrounding).not.toHaveBeenCalled();
  });

  it("runs secret grounding when only sensitive files remain after filters", async () => {
    isolatedWorkspace();
    const secretDiff = `diff --git a/.env b/.env
new file mode 100644
--- /dev/null
+++ b/.env
@@ -0,0 +1 @@
+API_KEY=AKIAIOSFODNN7EXAMPLE
`;
    const secretFinding = finding({
      file: ".env",
      line: 1,
      severity: "critical",
      category: "security",
      title: "generic-api-key",
      body: "Detected a Generic API Key."
    });
    const gatherGrounding = vi.fn().mockResolvedValue({
      findings: [secretFinding],
      notes: ["Gitleaks: 1 potential secret(s) on changed lines."]
    });
    const { deps: d, out } = deps({
      resolveDiff: vi.fn().mockResolvedValue(secretDiff),
      gatherGrounding
    });

    const result = await runLocalReview({ base: "main", config: false, failOn: "major" }, d);

    expect(gatherGrounding).toHaveBeenCalledWith(
      expect.objectContaining({
        changedPaths: [],
        secretScanPaths: [".env"],
        changedLines: { ".env": [1] }
      })
    );
    expect(d.gatherContext).not.toHaveBeenCalled();
    expect(d.runReview).not.toHaveBeenCalled();
    expect(result.findings).toEqual([secretFinding]);
    expect(result.failed).toBe(true);
    expect(out.join("\n")).toContain("generic-api-key");
  });

  it("surfaces a degraded specialist pass as a note (never silent)", async () => {
    isolatedWorkspace();
    const runReview = vi.fn().mockResolvedValue(
      reviewResult({
        findings: [finding()],
        passes: [{ specialist: "security", findings: 0, ok: false, error: "bad json" }]
      })
    );
    const { deps: d, out } = deps({ runReview });
    await runLocalReview({ base: "main", config: false }, d);
    expect(out.join("\n")).toContain('Specialist "security" degraded');
  });

  it("flags failure when a finding meets the --fail-on threshold", async () => {
    isolatedWorkspace();
    const runReview = vi.fn().mockResolvedValue(reviewResult({ findings: [finding({ severity: "critical" })] }));
    const { deps: d } = deps({ runReview });
    const result = await runLocalReview({ base: "main", config: false, failOn: "major" }, d);
    expect(result.failed).toBe(true);
  });

  it("does not flag failure when findings are below the --fail-on threshold", async () => {
    isolatedWorkspace();
    const runReview = vi.fn().mockResolvedValue(reviewResult({ findings: [finding({ severity: "minor" })] }));
    const { deps: d } = deps({ runReview });
    const result = await runLocalReview({ base: "main", config: false, failOn: "major" }, d);
    expect(result.failed).toBe(false);
  });

  it("handles a git failure gracefully without throwing", async () => {
    isolatedWorkspace();
    const { LocalDiffError } = await import("../src/review/local-diff.js");
    const resolveDiff = vi.fn().mockRejectedValue(new LocalDiffError("git diff failed: bad revision 'nope'"));
    const { deps: d, err } = deps({ resolveDiff });
    const result = await runLocalReview({ base: "nope", config: false }, d);
    expect(result.failed).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(err.join("\n")).toContain("bad revision");
  });

  it("fails before review when --head does not match the checked-out workspace", async () => {
    isolatedWorkspace();
    const { LocalDiffError } = await import("../src/review/local-diff.js");
    const resolveHead = vi
      .fn()
      .mockRejectedValue(
        new LocalDiffError("--head feature does not match the checked-out HEAD; switch to that ref.")
      );
    const { deps: d, err } = deps({ resolveHead });

    const result = await runLocalReview({ base: "main", head: "feature", config: false }, d);

    expect(result.failed).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(d.resolveDiff).not.toHaveBeenCalled();
    expect(d.gatherContext).not.toHaveBeenCalled();
    expect(d.gatherGrounding).not.toHaveBeenCalled();
    expect(d.runReview).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("does not match the checked-out HEAD");
  });
});

describe("resolveColor", () => {
  it("disables color when --no-color is set", () => {
    expect(resolveColor({ color: false }, {})).toBe(false);
  });

  it("disables color when NO_COLOR is present", () => {
    expect(resolveColor({}, { NO_COLOR: "1" })).toBe(false);
  });
});

describe("meetsFailThreshold", () => {
  it("is true when any finding is at/above the threshold", () => {
    expect(meetsFailThreshold([{ severity: "critical" } as Finding], "major")).toBe(true);
    expect(meetsFailThreshold([{ severity: "major" } as Finding], "major")).toBe(true);
  });
  it("is false when all findings are below the threshold", () => {
    expect(meetsFailThreshold([{ severity: "minor" } as Finding], "major")).toBe(false);
    expect(meetsFailThreshold([], "info")).toBe(false);
  });
});
