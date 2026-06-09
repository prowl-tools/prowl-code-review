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

/** GitHub diff side accepted by inline review comments. */
export type ReviewSide = "RIGHT" | "LEFT";

/** GitHub review event used when publishing the review payload. */
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** Inline comment payload accepted by GitHub's create-review endpoint. */
export interface ReviewComment {
  /** Repository-relative path to the commented file. */
  path: string;
  /** New-side line the comment anchors to (end line for a range). */
  line: number;
  /** Diff side for `line`. */
  side: ReviewSide;
  /** Start line for a multi-line comment range. */
  start_line?: number;
  /** Diff side for `start_line`. */
  start_side?: ReviewSide;
  /** Markdown body for the inline review comment. */
  body: string;
}

/** Result of mapping findings into inline comments. */
export interface InlineMapping {
  /** Findings successfully anchored as GitHub inline review comments. */
  comments: ReviewComment[];
  /** Findings that couldn't be anchored to a changed line. */
  unmapped: Finding[];
}

/** Complete review payload ready to publish to GitHub. */
export interface ReviewPayload {
  /** Markdown summary body for the pull request review. */
  body: string;
  /** Review event sent with the payload. */
  event: ReviewEvent;
  /** Inline comments included in the review. */
  comments: ReviewComment[];
}

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🟡",
  trivial: "🔵",
  info: "⚪"
};

/**
 * Build commentable new-side line numbers per file, preserving the hunk each
 * line belongs to so multi-line ranges never cross GitHub diff hunks.
 */
function newSideLineHunks(diff: ParsedDiff): Map<string, Map<number, number>> {
  const map = new Map<string, Map<number, number>>();
  for (const file of diff.files) {
    const lines = new Map<number, number>();
    file.hunks.forEach((hunk, hunkIndex) => {
      for (const line of hunk.lines) {
        if (line.newLine !== undefined) {
          lines.set(line.newLine, hunkIndex);
        }
      }
    });
    map.set(file.path, lines);
  }
  return map;
}

/** Return true when every line in a range is present in the same diff hunk. */
function sameHunkRange(lineHunks: Map<number, number>, start: number, end: number): boolean {
  const hunkIndex = lineHunks.get(start);
  if (hunkIndex === undefined || lineHunks.get(end) !== hunkIndex) {
    return false;
  }

  for (let line = start; line <= end; line += 1) {
    if (lineHunks.get(line) !== hunkIndex) {
      return false;
    }
  }

  return true;
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
 * when its file + line is a new-side line in the diff; multi-line findings only
 * become ranges when every line sits inside the same diff hunk. Everything else
 * is `unmapped`.
 */
export function buildInlineComments(findings: Finding[], diff: ParsedDiff): InlineMapping {
  const lines = newSideLineHunks(diff);
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

    if (
      finding.endLine !== undefined &&
      finding.endLine > finding.line &&
      sameHunkRange(fileLines, finding.line, finding.endLine)
    ) {
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
