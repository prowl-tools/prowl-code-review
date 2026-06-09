import type { ParsedDiff } from "./diff-types.js";
import type { Finding, Severity } from "./findings.js";

/**
 * Inline comments + committable suggestions (backlog #10).
 *
 * Pure mapping/formatting: turn ranked findings into GitHub review comments
 * anchored to exact diff lines, with a committable `suggestion` block when a fix
 * exists. Findings that don't land on a changed line are returned as `unmapped`
 * so the caller can keep them in the summary (no silent drop).
 */

export type ReviewSide = "RIGHT" | "LEFT";
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface ReviewComment {
  path: string;
  /** New-side line the comment anchors to (end line for a range). */
  line: number;
  side: ReviewSide;
  /** Start line for a multi-line comment range. */
  start_line?: number;
  start_side?: ReviewSide;
  body: string;
}

export interface InlineMapping {
  comments: ReviewComment[];
  /** Findings that couldn't be anchored to a changed line. */
  unmapped: Finding[];
}

export interface ReviewPayload {
  body: string;
  event: ReviewEvent;
  comments: ReviewComment[];
}

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🟡",
  trivial: "🔵",
  info: "⚪"
};

/** Build the set of commentable (new-side) line numbers per file from the diff. */
function newSideLines(diff: ParsedDiff): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of diff.files) {
    const lines = new Set<number>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.newLine !== undefined) {
          lines.add(line.newLine);
        }
      }
    }
    map.set(file.path, lines);
  }
  return map;
}

/** Wrap suggested code in a ```suggestion fence longer than any backtick run in it. */
function suggestionBlock(code: string): string {
  const longestRun = Math.max(0, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}suggestion\n${code.replace(/\n$/, "")}\n${fence}`;
}

/** Format one finding as an inline comment body (severity badge + optional fix). */
export function formatFindingComment(finding: Finding): string {
  const parts = [`${SEVERITY_BADGE[finding.severity]} **[${finding.severity}] ${finding.title}**`, "", finding.body];
  if (finding.suggestion && finding.suggestion.trim()) {
    parts.push("", suggestionBlock(finding.suggestion));
  }
  return parts.join("\n");
}

/**
 * Map findings to inline review comments anchored on the diff. A finding maps
 * when its file + line is a new-side line in the diff; multi-line findings whose
 * `endLine` is also in the diff become a range. Everything else is `unmapped`.
 */
export function buildInlineComments(findings: Finding[], diff: ParsedDiff): InlineMapping {
  const lines = newSideLines(diff);
  const comments: ReviewComment[] = [];
  const unmapped: Finding[] = [];

  for (const finding of findings) {
    const fileLines = lines.get(finding.file);
    if (finding.line === undefined || !fileLines || !fileLines.has(finding.line)) {
      unmapped.push(finding);
      continue;
    }

    const comment: ReviewComment = {
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: formatFindingComment(finding)
    };

    if (finding.endLine !== undefined && finding.endLine > finding.line && fileLines.has(finding.endLine)) {
      comment.start_line = finding.line;
      comment.start_side = "RIGHT";
      comment.line = finding.endLine;
    }

    comments.push(comment);
  }

  return { comments, unmapped };
}

/**
 * Assemble the single published review: the walkthrough `summaryBody` plus
 * inline comments for the findings that anchor to the diff. Unmapped findings
 * remain represented in the summary (which lists blockers by file:line).
 */
export function buildReviewPayload(input: {
  findings: Finding[];
  diff: ParsedDiff;
  summaryBody: string;
  event?: ReviewEvent;
}): ReviewPayload {
  const { comments } = buildInlineComments(input.findings, input.diff);
  return {
    body: input.summaryBody,
    event: input.event ?? "COMMENT",
    comments
  };
}
