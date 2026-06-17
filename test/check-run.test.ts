import { describe, expect, it, vi } from "vitest";
import {
  planCheckRun,
  submitCheckRun,
  annotationLevelFor,
  CHECK_ANNOTATION_BATCH
} from "../src/github/check-run.js";
import type { Finding, Severity } from "../src/review/findings.js";
import type { ApprovalDecision } from "../src/review/approval.js";
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

describe("planCheckRun with the approval rubric (#52)", () => {
  function decision(over: Partial<ApprovalDecision> = {}): ApprovalDecision {
    return {
      enabled: true,
      event: "REQUEST_CHANGES",
      blocking: 1,
      requestChangesAt: "critical",
      overridden: false,
      coverageDegraded: false,
      clearsPriorRequestChanges: false,
      reason: "test",
      ...over
    };
  }

  it("fails when the rubric requests changes", () => {
    const plan = planCheckRun({
      findings: [finding({ severity: "critical" })],
      approval: decision({ event: "REQUEST_CHANGES" })
    });
    expect(plan.conclusion).toBe("failure");
    expect(plan.summary).toContain("requesting changes");
  });

  it("passes when the rubric comments or approves", () => {
    for (const event of ["COMMENT", "APPROVE"] as const) {
      const plan = planCheckRun({
        findings: [finding({ severity: "major" })],
        approval: decision({ event, blocking: 0 })
      });
      expect(plan.conclusion).toBe("success");
    }
  });

  it("explains when approval is withheld for degraded coverage", () => {
    const plan = planCheckRun({
      findings: [],
      approval: decision({ event: "COMMENT", blocking: 0, coverageDegraded: true })
    });
    expect(plan.conclusion).toBe("success");
    expect(plan.summary).toContain("approval withheld");
  });

  it("explains when approval clears a prior request-changes review", () => {
    const plan = planCheckRun({
      findings: [],
      approval: decision({ event: "APPROVE", blocking: 0, clearsPriorRequestChanges: true })
    });
    expect(plan.conclusion).toBe("success");
    expect(plan.summary).toContain("clear a previous prowl-review change request");
  });

  it("passes (and records the override) on a break-glass approval", () => {
    const plan = planCheckRun({
      findings: [finding({ severity: "critical" })],
      approval: decision({ event: "APPROVE", overridden: true, overrideActor: "maintainer" })
    });
    expect(plan.conclusion).toBe("success");
    expect(plan.summary).toContain("break-glass override");
    expect(plan.summary).toContain("@maintainer");
  });

  it("uses the rubric threshold for the blocking count in the summary", () => {
    const plan = planCheckRun({
      findings: [finding({ severity: "major" }), finding({ severity: "major", line: 4 })],
      approval: decision({ event: "REQUEST_CHANGES", blocking: 2, requestChangesAt: "major" })
    });
    expect(plan.summary).toContain("2 finding(s) at or above `major`");
  });

  it("ignores a disabled rubric and falls back to failOn", () => {
    const plan = planCheckRun({
      findings: [finding({ severity: "critical" })],
      failOn: "critical",
      approval: decision({ enabled: false })
    });
    expect(plan.conclusion).toBe("failure");
    expect(plan.summary).toContain("this check fails");
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
