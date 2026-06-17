import { describe, expect, it } from "vitest";
import {
  planApprovalDecision,
  approvalNotes,
  DEFAULT_REQUEST_CHANGES_AT,
  type ApprovalConfig,
  type BreakGlassSignal
} from "../src/review/approval.js";
import type { Finding, Severity } from "../src/review/findings.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: 3,
    severity: "critical",
    category: "correctness",
    title: "Bug",
    body: "Explanation",
    confidence: 0.8,
    ...over
  };
}

const enabled: ApprovalConfig = { enabled: true };

describe("planApprovalDecision (#52)", () => {
  it("comments (disabled) when the gate is off, regardless of findings", () => {
    const decision = planApprovalDecision({ findings: [finding()], config: { enabled: false } });
    expect(decision.enabled).toBe(false);
    expect(decision.event).toBe("COMMENT");
    // Still reports the count it would have blocked on.
    expect(decision.blocking).toBe(1);
  });

  it("defaults the threshold to critical", () => {
    expect(planApprovalDecision({ findings: [], config: enabled }).requestChangesAt).toBe(
      DEFAULT_REQUEST_CHANGES_AT
    );
  });

  it("requests changes when a finding is at or above the threshold", () => {
    const decision = planApprovalDecision({ findings: [finding({ severity: "critical" })], config: enabled });
    expect(decision.event).toBe("REQUEST_CHANGES");
    expect(decision.blocking).toBe(1);
    expect(decision.overridden).toBe(false);
  });

  it("does not request changes for findings below the threshold", () => {
    const decision = planApprovalDecision({ findings: [finding({ severity: "major" })], config: enabled });
    expect(decision.event).toBe("COMMENT");
    expect(decision.blocking).toBe(0);
  });

  it("honors a configurable threshold (major requests changes when set)", () => {
    const decision = planApprovalDecision({
      findings: [finding({ severity: "major" })],
      config: { enabled: true, requestChangesAt: "major" }
    });
    expect(decision.event).toBe("REQUEST_CHANGES");
    expect(decision.blocking).toBe(1);
  });

  it("comments on a clean review by default", () => {
    expect(planApprovalDecision({ findings: [], config: enabled }).event).toBe("COMMENT");
  });

  it("approves a clean review when approveWhenClean is set", () => {
    const decision = planApprovalDecision({
      findings: [finding({ severity: "minor" })],
      config: { enabled: true, approveWhenClean: true }
    });
    expect(decision.event).toBe("APPROVE");
    expect(decision.overridden).toBe(false);
  });

  it("approves to clear a prior request-changes review even when approveWhenClean is off", () => {
    const decision = planApprovalDecision({
      findings: [finding({ severity: "major" })],
      config: enabled,
      priorRequestChanges: true
    });
    expect(decision.event).toBe("APPROVE");
    expect(decision.clearsPriorRequestChanges).toBe(true);
    expect(decision.reason).toContain("clear a prior");
  });

  it("does not approve a degraded clean review", () => {
    const decision = planApprovalDecision({
      findings: [],
      config: { enabled: true, approveWhenClean: true },
      coverageDegraded: true
    });
    expect(decision.event).toBe("COMMENT");
    expect(decision.coverageDegraded).toBe(true);
    expect(decision.reason).toContain("degraded");
  });

  it("does not approve a degraded review just to clear a prior request", () => {
    const decision = planApprovalDecision({
      findings: [],
      config: enabled,
      coverageDegraded: true,
      priorRequestChanges: true
    });
    expect(decision.event).toBe("COMMENT");
    expect(decision.clearsPriorRequestChanges).toBe(false);
  });

  describe("break-glass override", () => {
    const active: BreakGlassSignal = { active: true, actor: "maintainer", association: "OWNER" };

    it("force-approves past a blocking finding and records the actor", () => {
      const decision = planApprovalDecision({
        findings: [finding({ severity: "critical" })],
        config: enabled,
        breakGlass: active
      });
      expect(decision.event).toBe("APPROVE");
      expect(decision.overridden).toBe(true);
      expect(decision.overrideActor).toBe("maintainer");
      expect(decision.blocking).toBe(1);
    });

    it("is ignored when there is nothing blocking to override", () => {
      const decision = planApprovalDecision({ findings: [], config: enabled, breakGlass: active });
      expect(decision.event).toBe("COMMENT");
      expect(decision.overridden).toBe(false);
    });

    it("is not honored when breakGlass is disabled", () => {
      const decision = planApprovalDecision({
        findings: [finding({ severity: "critical" })],
        config: { enabled: true, breakGlass: false },
        breakGlass: active
      });
      expect(decision.event).toBe("REQUEST_CHANGES");
      expect(decision.overridden).toBe(false);
    });

    it("does not override when the signal is inactive", () => {
      const decision = planApprovalDecision({
        findings: [finding({ severity: "critical" })],
        config: enabled,
        breakGlass: { active: false }
      });
      expect(decision.event).toBe("REQUEST_CHANGES");
    });
  });
});

describe("approvalNotes (#52)", () => {
  it("is empty when the gate is disabled", () => {
    expect(approvalNotes(planApprovalDecision({ findings: [finding()], config: { enabled: false } }))).toEqual([]);
  });

  it("records a break-glass override for audit", () => {
    const notes = approvalNotes(
      planApprovalDecision({
        findings: [finding({ severity: "critical" })],
        config: enabled,
        breakGlass: { active: true, actor: "maintainer", association: "MEMBER" }
      })
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Break-glass override");
    expect(notes[0]).toContain("@maintainer");
    expect(notes[0]).toContain("audit");
  });

  it("explains a request-changes decision and how to override (mention is a code span)", () => {
    const notes = approvalNotes(
      planApprovalDecision({ findings: [finding({ severity: "critical" })], config: enabled })
    );
    expect(notes[0]).toContain("requesting changes");
    // The mention is wrapped in backticks so it can't notify or self-trigger.
    expect(notes[0]).toContain("`@prowl-review break glass`");
  });

  it("notes an approval decision", () => {
    const notes = approvalNotes(
      planApprovalDecision({ findings: [], config: { enabled: true, approveWhenClean: true } })
    );
    expect(notes[0]).toContain("approved");
  });

  it("notes an approval that clears a prior request-changes review", () => {
    const notes = approvalNotes(
      planApprovalDecision({ findings: [], config: enabled, priorRequestChanges: true })
    );
    expect(notes[0]).toContain("clear a previous");
  });

  it("notes when approval is withheld for degraded coverage", () => {
    const notes = approvalNotes(
      planApprovalDecision({
        findings: [],
        config: { enabled: true, approveWhenClean: true },
        coverageDegraded: true
      })
    );
    expect(notes[0]).toContain("not approving");
    expect(notes[0]).toContain("coverage was degraded");
  });

  it("emits no note for a plain comment decision", () => {
    expect(approvalNotes(planApprovalDecision({ findings: [], config: enabled }))).toEqual([]);
  });
});

describe("threshold inclusivity (#52)", () => {
  const severities: Severity[] = ["critical", "major", "minor", "trivial", "info"];
  it.each(severities)("treats %s at/above its own threshold as blocking", (severity) => {
    const decision = planApprovalDecision({
      findings: [finding({ severity })],
      config: { enabled: true, requestChangesAt: severity }
    });
    expect(decision.event).toBe("REQUEST_CHANGES");
  });
});
