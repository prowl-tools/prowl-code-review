import { describe, expect, it, vi } from "vitest";
import {
  planCheckRun,
  submitCheckRun,
  startCheckRun,
  annotationLevelFor,
  CHECK_ANNOTATION_BATCH,
  CHECK_RUN_NAME
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
  it("completes neutral when ungated", () => {
    // No failOn and no engaged approval gate means this is informational, not a
    // passing merge gate.
    const input: Parameters<typeof planCheckRun>[0] = { findings: [finding({ severity: "critical" })] };
    expect(input.failOn).toBeUndefined();
    expect(input.approval).toBeUndefined();
    const plan = planCheckRun(input);
    expect(plan.conclusion).toBe("neutral");
    expect(plan.summary).toContain("informational only");
    expect(plan.summary).toContain("set checkRun.failOn or approval.enabled");
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

describe("planCheckRun skipped/incomplete + partial coverage (#65)", () => {
  it("is neutral 'Review skipped/incomplete' when the review had no coverage, overriding the gate", () => {
    const plan = planCheckRun({
      findings: [],
      failOn: "critical", // gated: without the skip this would be a green success
      coverage: { passed: 0, total: 4 },
      incomplete: { reason: "Codex subscription usage limit reached." }
    });
    expect(plan.conclusion).toBe("neutral");
    expect(plan.title).toBe("Review skipped/incomplete");
    expect(plan.summary).toContain("usage limit");
    expect(plan.annotations).toEqual([]);
  });

  it("never reports a green 'No issues found' when all passes failed (regression for #92)", () => {
    const plan = planCheckRun({
      findings: [],
      failOn: "major",
      coverage: { passed: 0, total: 4 },
      incomplete: { reason: "all review specialist passes failed" }
    });
    expect(plan.conclusion).not.toBe("success");
    expect(plan.title).not.toContain("No issues found");
  });

  it("says 'No issues found in N/M passes' for a zero-finding partially-degraded run", () => {
    const plan = planCheckRun({
      findings: [],
      failOn: "critical",
      coverage: { passed: 3, total: 4 }
    });
    expect(plan.conclusion).toBe("success");
    expect(plan.title).toBe("No issues found in 3/4 passes");
    expect(plan.summary).toContain("coverage partial");
  });

  it("keeps a plain 'No issues found' when coverage is complete", () => {
    const plan = planCheckRun({ findings: [], failOn: "critical", coverage: { passed: 4, total: 4 } });
    expect(plan.title).toBe("No issues found");
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
    expect(plan.conclusion).toBe("failure");
    expect(plan.summary).toContain("approval withheld");
    expect(plan.summary).toContain("this check fails");
  });

  it("fails when prior finding threads block automatic approval", () => {
    const plan = planCheckRun({
      findings: [],
      approval: decision({ event: "COMMENT", blocking: 0, threadApprovalBlocked: true })
    });
    expect(plan.conclusion).toBe("failure");
    expect(plan.summary).toContain("prior finding thread");
    expect(plan.summary).toContain("this check fails");
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
    expect(arg).toMatchObject({
      owner: "o",
      repo: "r",
      name: "Prowl Review",
      head_sha: "head",
      status: "completed",
      conclusion: "failure"
    });
    expect(arg.name).toBe(CHECK_RUN_NAME);
    expect(arg.output.annotations).toHaveLength(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("completes an existing live run in place when given a checkRunId (no new run)", async () => {
    const { octokit, create, update } = mockOctokit();
    const plan = planCheckRun({ findings: [finding({ severity: "critical" })], failOn: "critical" });
    await submitCheckRun(octokit, ref, { headSha: "head", plan, checkRunId: 42 });

    // The live row is completed via update, not a duplicate create.
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg).toMatchObject({
      owner: "o",
      repo: "r",
      check_run_id: 42,
      status: "completed",
      conclusion: "failure"
    });
    expect(typeof arg.completed_at).toBe("string");
    expect(arg.output.annotations).toHaveLength(1);
  });

  it("completes an existing live run and still batches overflow annotations via update", async () => {
    const { octokit, create, update } = mockOctokit();
    const findings = Array.from({ length: CHECK_ANNOTATION_BATCH + 5 }, (_, i) =>
      finding({ line: i + 1, file: `src/f${i}.ts` })
    );
    const plan = planCheckRun({ findings, failOn: "critical" });
    await submitCheckRun(octokit, ref, { headSha: "head", plan, checkRunId: 7 });

    expect(create).not.toHaveBeenCalled();
    // One update completes the run (first batch), a second attaches the overflow.
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][0].check_run_id).toBe(7);
    expect(update.mock.calls[0][0].status).toBe("completed");
    expect(typeof update.mock.calls[0][0].completed_at).toBe("string");
    expect(update.mock.calls[0][0].output.annotations).toHaveLength(CHECK_ANNOTATION_BATCH);
    expect(update.mock.calls[1][0].check_run_id).toBe(7);
    expect(update.mock.calls[1][0].completed_at).toBe(update.mock.calls[0][0].completed_at);
    expect(update.mock.calls[1][0].output.annotations).toHaveLength(5);
  });

  it("preserves a completed live-run conclusion when an overflow annotation batch fails", async () => {
    const { octokit, create, update } = mockOctokit();
    update.mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce(new Error("temporary checks API failure"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const findings = Array.from({ length: CHECK_ANNOTATION_BATCH + 5 }, (_, i) =>
      finding({ line: i + 1, file: `src/f${i}.ts` })
    );
    const plan = planCheckRun({ findings, failOn: "major" });

    await expect(submitCheckRun(octokit, ref, { headSha: "head", plan, checkRunId: 7 })).resolves.toBeUndefined();

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][0]).toMatchObject({
      check_run_id: 7,
      status: "completed",
      conclusion: "failure"
    });
    expect(update.mock.calls[0][0].output.title).toBe(plan.title);
    expect(update.mock.calls[1][0].completed_at).toBe(update.mock.calls[0][0].completed_at);
    expect(update.mock.calls[1][0].output.annotations).toHaveLength(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to attach overflow check-run annotations"));
    warn.mockRestore();
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

describe("startCheckRun (#59 follow-up)", () => {
  const ref = { owner: "o", repo: "r", pull_number: 7 };

  function mockOctokit() {
    const create = vi.fn(async () => ({ data: { id: 123 } }));
    const update = vi.fn(async () => ({ data: {} }));
    const octokit = { rest: { checks: { create, update } } } as unknown as OctokitLike;
    return { octokit, create, update };
  }

  it("opens an in-progress run with a started_at and returns its id", async () => {
    const { octokit, create, update } = mockOctokit();
    const id = await startCheckRun(octokit, ref, { headSha: "head" });

    expect(id).toBe(123);
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0];
    expect(arg).toMatchObject({
      owner: "o",
      repo: "r",
      name: "Prowl Review",
      head_sha: "head",
      status: "in_progress"
    });
    expect(typeof arg.started_at).toBe("string");
    expect(arg.output.title).toBe("Review in progress");
    expect(arg.conclusion).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it("honors a custom check-run name", async () => {
    const { octokit, create } = mockOctokit();
    await startCheckRun(octokit, ref, { headSha: "head", name: "Custom" });
    expect(create.mock.calls[0][0].name).toBe("Custom");
  });
});
