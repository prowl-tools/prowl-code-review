import type { OctokitLike } from "./client.js";
import type { PullRequestRef } from "./diff.js";
import { type Finding, type Severity, SEVERITY_ORDER } from "../review/findings.js";
import type { ApprovalDecision } from "../review/approval.js";

/**
 * Check Run / merge gate (backlog #24).
 *
 * Publishes a GitHub Check Run summarizing the review: a conclusion derived from
 * the worst finding severity against a configurable `failOn` threshold, a summary,
 * and per-line annotations. A `failure` conclusion only blocks merge when the org
 * marks the check Required in branch protection — so this is safe to enable; it is
 * informational until someone opts into gating. Needs the `checks: write`
 * permission, so it is **opt-in** (`checkRun.enabled`).
 *
 * `planCheckRun` is pure and unit-tested; `submitCheckRun` performs the GitHub
 * writes (batched, since the Checks API caps annotations per request).
 */

/** The default Check Run name shown on the PR. */
export const CHECK_RUN_NAME = "prowl-review";

/** GitHub caps annotations at 50 per check-run create/update request. */
export const CHECK_ANNOTATION_BATCH = 50;

/** GitHub annotation levels. */
export type AnnotationLevel = "notice" | "warning" | "failure";

/** GitHub check-run conclusions prowl-review emits. */
export type CheckConclusion = "success" | "failure" | "neutral";

/** One per-line annotation attached to the check run. */
export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: AnnotationLevel;
  message: string;
  title?: string;
}

/** The pure check-run decision derived from findings + the gate config. */
export interface CheckRunPlan {
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  annotations: CheckAnnotation[];
}

/** Map a finding severity to a GitHub annotation level. */
export function annotationLevelFor(severity: Severity): AnnotationLevel {
  if (severity === "critical" || severity === "major") {
    return "failure";
  }
  if (severity === "minor") {
    return "warning";
  }
  return "notice";
}

/** Keep an annotation message within GitHub's per-annotation limit. */
function annotationMessage(finding: Finding): string {
  const body = finding.body.trim();
  const max = 600;
  return body.length > max ? `${body.slice(0, max - 3)}...` : body;
}

/** Count findings by severity for the summary. */
function severityBreakdown(findings: Finding[]): string {
  const counts = new Map<Severity, number>();
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  const order: Severity[] = ["critical", "major", "minor", "trivial", "info"];
  const parts = order.filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${s}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** Build the "Gate:" summary line, reflecting the approval rubric (#52) or failOn. */
function gateSummaryLine(input: {
  approval?: ApprovalDecision;
  failOn?: Severity;
  conclusion: CheckConclusion;
  blocking: number;
}): string {
  const { approval, failOn, conclusion, blocking } = input;
  if (approval) {
    if (approval.overridden) {
      return (
        `Gate: break-glass override${approval.overrideActor ? ` by @${approval.overrideActor}` : ""} — ` +
        `approved past ${blocking} finding(s) at or above \`${approval.requestChangesAt}\` (this check passes).`
      );
    }
    if (approval.event === "REQUEST_CHANGES") {
      return `Gate: ${blocking} finding(s) at or above \`${approval.requestChangesAt}\` — requesting changes (this check fails).`;
    }
    if (approval.coverageDegraded) {
      return "Gate: review coverage degraded — approval withheld (this check passes).";
    }
    return `Gate: no findings at or above \`${approval.requestChangesAt}\` — this check passes.`;
  }
  if (failOn !== undefined) {
    return conclusion === "failure"
      ? `Gate: ${blocking} finding(s) at or above \`${failOn}\` — this check fails.`
      : `Gate: no findings at or above \`${failOn}\` — this check passes.`;
  }
  return "Gate: informational only (set checkRun.failOn or approval.enabled to block on severity).";
}

/**
 * Decide the check-run conclusion, summary, and annotations from the findings.
 *
 * When an approval decision (#52) is supplied and engaged, the check follows the
 * **same** rubric as the published review event — request-changes → `failure`,
 * comment/approve → `success`, and a break-glass override → `success` — so the
 * gate and the review can never disagree. Otherwise it falls back to `failOn`:
 * any finding at or above that severity makes the conclusion `failure`, else
 * `success`; with `failOn` omitted too, the check is purely informational
 * (`neutral`). Findings without a line can't be annotated, so they are reported
 * in the summary count but not as annotations (no silent drop, #5).
 */
export function planCheckRun(input: {
  findings: Finding[];
  failOn?: Severity;
  /** Incremental runs (#23) gate on the delta; surfaced in the summary. */
  incremental?: boolean;
  /** Approval rubric decision (#52); when engaged it drives the conclusion. */
  approval?: ApprovalDecision;
}): CheckRunPlan {
  const { findings, failOn } = input;
  const approval = input.approval?.enabled ? input.approval : undefined;

  const gated = approval !== undefined || failOn !== undefined;
  const blocking = approval
    ? findings.filter((f) => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[approval.requestChangesAt])
    : failOn !== undefined
      ? findings.filter((f) => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[failOn])
      : [];
  const conclusion: CheckConclusion = approval
    ? approval.overridden || approval.event !== "REQUEST_CHANGES"
      ? "success"
      : "failure"
    : !gated
      ? "neutral"
      : blocking.length > 0
        ? "failure"
        : "success";

  const annotations: CheckAnnotation[] = findings
    .filter((finding): finding is Finding & { line: number } => finding.line !== undefined)
    .map((finding) => ({
      path: finding.file,
      start_line: finding.line,
      end_line: finding.endLine ?? finding.line,
      annotation_level: annotationLevelFor(finding.severity),
      message: annotationMessage(finding),
      title: `[${finding.severity}] ${finding.title}`
    }));

  const total = findings.length;
  const title =
    total === 0
      ? "No issues found"
      : `${total} finding${total === 1 ? "" : "s"} (${severityBreakdown(findings)})`;

  const summaryLines = [
    input.incremental ? "Incremental review of the latest changes (#23)." : "",
    total === 0
      ? "prowl-review found no issues in the reviewed changes."
      : `prowl-review found ${total} finding${total === 1 ? "" : "s"}: ${severityBreakdown(findings)}.`,
    gateSummaryLine({ approval, failOn, conclusion, blocking: blocking.length }),
    annotations.length < total
      ? `${total - annotations.length} finding(s) without a line are summarized but not annotated.`
      : ""
  ].filter(Boolean);

  return { conclusion, title, summary: summaryLines.join("\n\n"), annotations };
}

/** Split annotations into Checks-API-sized batches. */
function batchAnnotations(annotations: CheckAnnotation[]): CheckAnnotation[][] {
  if (annotations.length === 0) {
    return [[]];
  }
  const batches: CheckAnnotation[][] = [];
  for (let i = 0; i < annotations.length; i += CHECK_ANNOTATION_BATCH) {
    batches.push(annotations.slice(i, i + CHECK_ANNOTATION_BATCH));
  }
  return batches;
}

/**
 * Create the Check Run and attach annotations. The first batch (≤50) goes on the
 * create call; any remaining batches are added via update calls, since the Checks
 * API caps annotations per request.
 */
export async function submitCheckRun(
  octokit: OctokitLike,
  ref: PullRequestRef,
  input: { headSha: string; plan: CheckRunPlan; name?: string }
): Promise<void> {
  const name = input.name ?? CHECK_RUN_NAME;
  const { plan } = input;
  const batches = batchAnnotations(plan.annotations);

  const created = await octokit.rest.checks.create({
    owner: ref.owner,
    repo: ref.repo,
    name,
    head_sha: input.headSha,
    status: "completed",
    conclusion: plan.conclusion,
    output: {
      title: plan.title,
      summary: plan.summary,
      annotations: batches[0]
    }
  });

  const checkRunId = created.data.id;
  for (let i = 1; i < batches.length; i += 1) {
    await octokit.rest.checks.update({
      owner: ref.owner,
      repo: ref.repo,
      check_run_id: checkRunId,
      output: {
        title: plan.title,
        summary: plan.summary,
        annotations: batches[i]
      }
    });
  }
}
