import { describe, expect, it } from "vitest";
import {
  diffComplexity,
  selectRiskTier,
  planOrchestration,
  DEFAULT_TIER_THRESHOLDS,
  MINIMAL_TIER_BUILTINS
} from "../src/review/risk-tier.js";
import type { DiffFile, DiffLine } from "../src/review/diff-types.js";

function line(type: DiffLine["type"]): DiffLine {
  return { type, content: "x" };
}

/** Build a DiffFile with `adds` added + `dels` deleted lines (plus one context line). */
function file(path: string, adds: number, dels: number): DiffFile {
  const lines: DiffLine[] = [
    line("context"),
    ...Array.from({ length: adds }, () => line("add")),
    ...Array.from({ length: dels }, () => line("del"))
  ];
  return {
    path,
    status: "modified",
    binary: false,
    byteSize: 100,
    hunks: [{ oldStart: 1, oldLines: dels, newStart: 1, newLines: adds, section: "", lines }]
  };
}

describe("diffComplexity", () => {
  it("counts added + deleted lines (not context) across files", () => {
    const complexity = diffComplexity([file("a.ts", 5, 3), file("b.ts", 2, 0)]);
    expect(complexity).toEqual({ changedLines: 10, fileCount: 2 });
  });

  it("is zero for an empty diff", () => {
    expect(diffComplexity([])).toEqual({ changedLines: 0, fileCount: 0 });
  });
});

describe("selectRiskTier (#31)", () => {
  it("picks minimal for a tiny diff (both bounds satisfied)", () => {
    const sel = selectRiskTier({ changedLines: 12, fileCount: 1 });
    expect(sel.tier).toBe("minimal");
    expect(sel).toMatchObject({ changedLines: 12, fileCount: 1 });
  });

  it("stays standard when only one minimal bound holds", () => {
    expect(selectRiskTier({ changedLines: 12, fileCount: 5 }).tier).toBe("standard"); // too many files
    expect(selectRiskTier({ changedLines: 200, fileCount: 1 }).tier).toBe("standard"); // too many lines
  });

  it("picks deep when either deep bound is met", () => {
    expect(selectRiskTier({ changedLines: 600, fileCount: 1 }).tier).toBe("deep"); // lines
    expect(selectRiskTier({ changedLines: 10, fileCount: 25 }).tier).toBe("deep"); // files
  });

  it("deep takes precedence over minimal at the boundary", () => {
    // A huge single-file change is deep, never minimal.
    expect(selectRiskTier({ changedLines: 500, fileCount: 1 }).tier).toBe("deep");
  });

  it("uses the default thresholds at the exact boundaries", () => {
    const { minimal, deep } = DEFAULT_TIER_THRESHOLDS;
    expect(selectRiskTier({ changedLines: minimal.maxChangedLines, fileCount: minimal.maxFiles }).tier).toBe("minimal");
    expect(selectRiskTier({ changedLines: deep.minChangedLines, fileCount: 1 }).tier).toBe("deep");
    expect(selectRiskTier({ changedLines: 1, fileCount: deep.minFiles }).tier).toBe("deep");
  });

  it("always returns standard when disabled", () => {
    expect(selectRiskTier({ changedLines: 1, fileCount: 1 }, { enabled: false }).tier).toBe("standard");
    expect(selectRiskTier({ changedLines: 9999, fileCount: 99 }, { enabled: false }).tier).toBe("standard");
  });

  it("honors config threshold overrides", () => {
    const config = { minimal: { maxChangedLines: 5, maxFiles: 1 }, deep: { minChangedLines: 50, minFiles: 5 } };
    expect(selectRiskTier({ changedLines: 12, fileCount: 1 }, config).tier).toBe("standard"); // > custom minimal
    expect(selectRiskTier({ changedLines: 4, fileCount: 1 }, config).tier).toBe("minimal");
    expect(selectRiskTier({ changedLines: 60, fileCount: 1 }, config).tier).toBe("deep");
    expect(selectRiskTier({ changedLines: 1, fileCount: 5 }, config).tier).toBe("deep");
  });
});

describe("planOrchestration (#31)", () => {
  it("minimal trims built-ins to correctness+security and tightens context", () => {
    const plan = planOrchestration("minimal");
    expect(plan.builtinSpecialistKeys).toEqual([...MINIMAL_TIER_BUILTINS]);
    expect(plan.contextLimits).toEqual({ maxRounds: 3, maxFiles: 6 });
  });

  it("standard makes no adjustments", () => {
    expect(planOrchestration("standard")).toEqual({});
  });

  it("deep expands context and keeps the full pass set", () => {
    const plan = planOrchestration("deep");
    expect(plan.builtinSpecialistKeys).toBeUndefined();
    expect(plan.contextLimits).toEqual({ maxRounds: 8, maxFiles: 30 });
  });
});
