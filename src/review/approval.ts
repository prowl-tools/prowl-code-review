import { type Finding, type Severity, SEVERITY_ORDER } from "./findings.js";
import type { ReviewEvent } from "./inline.js";

/**
 * Approval rubric + break-glass override (backlog #52).
 *
 * Maps the surfaced findings to a single GitHub review event so the gate behaves
 * predictably: any finding at or above `requestChangesAt` (default `critical`)
 * makes the review **request changes**; an otherwise clean review **comments**
 * (or **approves**, if opted in). The decision is the one source of truth shared
 * by the published review event and the #24 Check Run conclusion, so the two can
 * never disagree.
 *
 * The whole gate is **opt-in** (`approval.enabled`): a bot that requests changes
 * is intrusive, so by default prowl-review only ever comments (the prior
 * behavior). The escape hatch is a `@prowl-review break glass` comment from a
 * repo owner/member/collaborator (see {@link ../github/break-glass.js}): it
 * force-approves past a blocking finding and is recorded in the review for
 * auditability, keeping a human in control of the merge.
 *
 * `planApprovalDecision` is pure and unit-tested; the break-glass signal it
 * consumes is gathered by the GitHub layer.
 */

/** `.prowl-review.yml` `approval` block (#52). */
export interface ApprovalConfig {
  /** Engage the rubric. Default false → always COMMENT (the prior behavior). */
  enabled?: boolean;
  /** Severity at/above which the review requests changes. Default `critical`. */
  requestChangesAt?: Severity;
  /** Approve (not just comment) when nothing is at/above the threshold. Default false. */
  approveWhenClean?: boolean;
  /** Honor `@prowl-review break glass` overrides. Default true. */
  breakGlass?: boolean;
}

/** Default severity that triggers a request-changes decision. */
export const DEFAULT_REQUEST_CHANGES_AT: Severity = "critical";

/** A detected `@prowl-review break glass` override signal from the PR. */
export interface BreakGlassSignal {
  /** True when a trusted override comment is present. */
  active: boolean;
  /** Login of the commenter who triggered the override (audit). */
  actor?: string;
  /** GitHub author association of that commenter (audit). */
  association?: string;
}

/** The resolved gate decision driving the review event + check conclusion. */
export interface ApprovalDecision {
  /** Whether the rubric is engaged; false → always COMMENT. */
  enabled: boolean;
  /** GitHub review event to publish. */
  event: ReviewEvent;
  /** Count of findings at/above {@link ApprovalDecision.requestChangesAt}. */
  blocking: number;
  /** The threshold actually applied. */
  requestChangesAt: Severity;
  /** True when a break-glass override flipped request-changes into approval. */
  overridden: boolean;
  /** True when approval was withheld because review coverage was degraded or incomplete. */
  coverageDegraded: boolean;
  /** True when approval clears an earlier prowl-review request-changes review. */
  clearsPriorRequestChanges: boolean;
  /** True when break-glass was disabled because head freshness could not be verified. */
  breakGlassFreshnessUnknown?: boolean;
  /** True when prior review history hit the pagination cap before a complete answer. */
  priorRequestChangesTruncated?: boolean;
  /** Login of the override actor, when overridden (audit). */
  overrideActor?: string;
  /** One-line human-readable reason for the decision. */
  reason: string;
}

/**
 * Decide the review event from the findings, the gate config, and any break-glass
 * signal. Pure — no GitHub calls.
 */
export function planApprovalDecision(input: {
  findings: Finding[];
  config?: ApprovalConfig;
  breakGlass?: BreakGlassSignal;
  coverageDegraded?: boolean;
  priorRequestChanges?: boolean;
  breakGlassFreshnessUnknown?: boolean;
  priorRequestChangesTruncated?: boolean;
}): ApprovalDecision {
  const config = input.config ?? {};
  const requestChangesAt = config.requestChangesAt ?? DEFAULT_REQUEST_CHANGES_AT;
  const coverageDegraded = input.coverageDegraded === true;
  const priorRequestChanges = input.priorRequestChanges === true;
  const breakGlassFreshnessUnknown = input.breakGlassFreshnessUnknown === true;
  const priorRequestChangesTruncated = input.priorRequestChangesTruncated === true;
  const blocking = input.findings.filter(
    (finding) => SEVERITY_ORDER[finding.severity] <= SEVERITY_ORDER[requestChangesAt]
  ).length;

  if (config.enabled !== true) {
    return {
      enabled: false,
      event: "COMMENT",
      blocking,
      requestChangesAt,
      overridden: false,
      coverageDegraded,
      clearsPriorRequestChanges: false,
      breakGlassFreshnessUnknown,
      priorRequestChangesTruncated,
      reason: "Approval gate disabled; posting as a comment."
    };
  }

  if (coverageDegraded) {
    return {
      enabled: true,
      event: blocking > 0 ? "REQUEST_CHANGES" : "COMMENT",
      blocking,
      requestChangesAt,
      overridden: false,
      coverageDegraded,
      clearsPriorRequestChanges: false,
      breakGlassFreshnessUnknown,
      priorRequestChangesTruncated,
      reason:
        blocking > 0
          ? `${blocking} finding(s) at or above ${requestChangesAt}; requesting changes with incomplete coverage.`
          : "Review coverage incomplete; posting as a comment instead of approving."
    };
  }

  if (blocking > 0) {
    const breakGlassHonored =
      !breakGlassFreshnessUnknown && config.breakGlass !== false && input.breakGlass?.active === true;
    if (breakGlassHonored) {
      const actor = input.breakGlass?.actor;
      return {
        enabled: true,
        event: "APPROVE",
        blocking,
        requestChangesAt,
        overridden: true,
        coverageDegraded,
        clearsPriorRequestChanges: false,
        breakGlassFreshnessUnknown: false,
        priorRequestChangesTruncated,
        overrideActor: actor,
        reason:
          `Break-glass override${actor ? ` by @${actor}` : ""}: approving past ` +
          `${blocking} finding(s) at or above ${requestChangesAt}.`
      };
    }
    return {
      enabled: true,
      event: "REQUEST_CHANGES",
      blocking,
      requestChangesAt,
      overridden: false,
      coverageDegraded,
      clearsPriorRequestChanges: false,
      breakGlassFreshnessUnknown,
      priorRequestChangesTruncated,
      reason: breakGlassFreshnessUnknown
        ? `${blocking} finding(s) at or above ${requestChangesAt}; requesting changes because break-glass freshness could not be verified.`
        : `${blocking} finding(s) at or above ${requestChangesAt}; requesting changes.`
    };
  }

  if (priorRequestChangesTruncated) {
    return {
      enabled: true,
      event: "COMMENT",
      blocking,
      requestChangesAt,
      overridden: false,
      coverageDegraded,
      clearsPriorRequestChanges: false,
      breakGlassFreshnessUnknown,
      priorRequestChangesTruncated,
      reason: "Prior prowl-review history was truncated; posting as a comment instead of approving."
    };
  }

  if (priorRequestChanges || config.approveWhenClean === true) {
    return {
      enabled: true,
      event: "APPROVE",
      blocking,
      requestChangesAt,
      overridden: false,
      coverageDegraded,
      clearsPriorRequestChanges: priorRequestChanges,
      breakGlassFreshnessUnknown,
      priorRequestChangesTruncated,
      reason: priorRequestChanges
        ? `No findings at or above ${requestChangesAt}; approving to clear a prior prowl-review change request.`
        : `No findings at or above ${requestChangesAt}; approving.`
    };
  }

  return {
    enabled: true,
    event: "COMMENT",
    blocking,
    requestChangesAt,
    overridden: false,
    coverageDegraded,
    clearsPriorRequestChanges: false,
    breakGlassFreshnessUnknown,
    priorRequestChangesTruncated,
    reason: `No findings at or above ${requestChangesAt}; posting as a comment.`
  };
}

/**
 * Surface the gate decision as review notes so it isn't silent (#5). A
 * break-glass override is always recorded for auditability; a request-changes
 * decision tells the author how to override. Returns [] when the gate is off.
 * The `@prowl-review` mention is wrapped in a code span so rendering it can't
 * notify anyone or self-trigger another override.
 */
export function approvalNotes(decision: ApprovalDecision): string[] {
  if (!decision.enabled) {
    return [];
  }
  if (decision.overridden) {
    return [
      `🔓 Break-glass override (#52)${decision.overrideActor ? ` by @${decision.overrideActor}` : ""}: ` +
        `approved past ${decision.blocking} finding(s) at or above \`${decision.requestChangesAt}\`. ` +
        `Recorded for audit.`
    ];
  }
  if (decision.event === "REQUEST_CHANGES") {
    return [
      `Approval gate (#52): requesting changes — ${decision.blocking} finding(s) at or above ` +
        `\`${decision.requestChangesAt}\`. A repo owner/member/collaborator can override by commenting ` +
        "`@prowl-review break glass`." +
        (decision.breakGlassFreshnessUnknown
          ? " Break-glass overrides were ignored because the head commit timestamp could not be verified."
          : "")
    ];
  }
  if (decision.coverageDegraded) {
    return ["Approval gate (#52): not approving because review coverage was incomplete."];
  }
  if (decision.priorRequestChangesTruncated) {
    return [
      "Approval gate (#52): not approving because prior prowl-review review history hit the pagination cap."
    ];
  }
  if (decision.clearsPriorRequestChanges) {
    return [
      `Approval gate (#52): approved to clear a previous prowl-review change request — no findings at or above ` +
        `\`${decision.requestChangesAt}\`.`
    ];
  }
  if (decision.event === "APPROVE") {
    return [`Approval gate (#52): approved — no findings at or above \`${decision.requestChangesAt}\`.`];
  }
  return [];
}
