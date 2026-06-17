import { describe, expect, it, vi } from "vitest";
import {
  planCheckRun,
  submitCheckRun,
  annotationLevelFor,
  CHECK_ANNOTATION_BATCH
} from "../src/github/check-run.js";
import type { Finding, Severity } from "../src/review/findings.js";
import type { OctokitLike } from "../src/github/client.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: 3,
    severity: "major",
    category: "correctness",
    title: "Bug",
    body: "Explanation",
    confidence: 0.7,
    ...over
  };
}

describe("annotationLevelFor (#24)", () => {
  const cases: Array<[Severity, string]> = [
    ["critical", "failure"],
    ["major", "failure"],
    ["minor", "warning"],
    ["trivial", "notice"],
    ["info", "notice"]
  ];
  it.each(cases)("maps %s → %s", (severity, level) => {
    expect(annotationLevelFor(severity)).toBe(level);
  });
});

describe("planCheckRun (#24)", () => {
  it("is informational (neutral) when no failOn is set", () => {
    const plan = planCheckRun({ findings: [finding({ severity: "critical" })] });
    expect(plan.conclusion).toBe("neutral");
    expect(plan.summary).toContain("informational only");
  });

  it("fails when a finding is at or above failOn", () => {
    const plan = planCheckRun({ findings: [finding({ severity: "critical" })], failOn: "critical" });
    expect(plan.conclusion).toBe("failure");
    expect(plan.summary).toContain("this check fails");
  });

  it("passes when all findings are below failOn", () => {
    // failOn critical → a major finding does not block.
    const plan = planCheckRun({ findings: [finding({ severity: "major" })], failOn: "critical" });
    expect(plan.conclusion).toBe("success");
    expect(plan.summary).toContain("this check passes");
  });

  it("treats failOn inclusively (major fails on failOn: major)", () => {
    expect(planCheckRun({ findings: [finding({ severity: "major" })], failOn: "major" }).conclusion).toBe("failure");
  });

  it("passes a no-findings run when gated", () => {
    expect(planCheckRun({ findings: [], failOn: "critical" }).conclusion).toBe("success");
  });

  it("maps findings to annotations with level + end line", () => {
    const plan = planCheckRun({
      findings: [finding({ severity: "minor", line: 4, endLine: 6 })],
      failOn: "critical"
    });
    expect(plan.annotations).toEqual([
      {
        path: "src/a.ts",
        start_line: 4,
        end_line: 6,
        annotation_level: "warning",
        message: "Explanation",
        title: "[minor] Bug"
      }
    ]);
  });

  it("counts findings without a line but does not annotate them (#5)", () => {
    const plan = planCheckRun({
      findings: [finding({ line: undefined }), finding({ line: 2 })],
      failOn: "critical"
    });
    expect(plan.annotations).toHaveLength(1);
    expect(plan.title).toContain("2 findings");
    expect(plan.summary).toContain("1 finding(s) without a line");
  });
});

describe("submitCheckRun (#24)", () => {
  const ref = { owner: "o", repo: "r", pull_number: 7 };

  function mockOctokit() {
    const create = vi.fn(async () => ({ data: { id: 99 } }));
    const update = vi.fn(async () => ({ data: {} }));
    const octokit = { rest: { checks: { create, update } } } as unknown as OctokitLike;
    return { octokit, create, update };
  }

  it("creates a completed check run with the conclusion and first annotation batch", async () => {
    const { octokit, create, update } = mockOctokit();
    const plan = planCheckRun({ findings: [finding({ severity: "critical" })], failOn: "critical" });
    await submitCheckRun(octokit, ref, { headSha: "head", plan });

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0];
    expect(arg).toMatchObject({ owner: "o", repo: "r", name: "prowl-review", head_sha: "head", status: "completed", conclusion: "failure" });
    expect(arg.output.annotations).toHaveLength(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("batches annotations beyond the per-request cap via update calls", async () => {
    const { octokit, create, update } = mockOctokit();
    const findings = Array.from({ length: CHECK_ANNOTATION_BATCH + 20 }, (_, i) =>
      finding({ line: i + 1, file: `src/f${i}.ts` })
    );
    const plan = planCheckRun({ findings, failOn: "critical" });
    await submitCheckRun(octokit, ref, { headSha: "head", plan });

    expect(create.mock.calls[0][0].output.annotations).toHaveLength(CHECK_ANNOTATION_BATCH);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].output.annotations).toHaveLength(20);
    expect(update.mock.calls[0][0].check_run_id).toBe(99);
  });
});
