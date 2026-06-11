import type { ParsedDiff } from "./diff-types.js";
import type { Finding, Severity } from "./findings.js";
import { findingFingerprint } from "./state.js";

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
  /** Stable fingerprint of the source finding, for update-not-duplicate dedup (#12/#22). */
  fingerprint: string;
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

const MARKDOWN_TEXT_ESCAPES = new Set("\\`*_{}[]()#+-.!|><@".split(""));
const MARKDOWN_PARAGRAPH_ESCAPES = new Set("\\`*_{}[]()#+!|><@".split(""));

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

/** Replace control characters so untrusted finding text cannot alter Markdown. */
function normalizeMarkdownText(value: string): string {
  let normalized = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      if (char === "\n") {
        normalized += "\\n";
      } else if (char === "\r") {
        normalized += "\\r";
      } else if (char === "\t") {
        normalized += "\\t";
      } else {
        normalized += `\\x${code.toString(16).padStart(2, "0")}`;
      }
    } else {
      normalized += char;
    }
  }
  return normalized;
}

/** Render mention markers as entities so GitHub does not notify users or teams. */
function neutralizeMentions(value: string): string {
  return value.replaceAll("\\@", "&#64;").replaceAll("@", "&#64;");
}

/** Detect an ordered-list marker that would alter Markdown paragraph structure. */
function isOrderedListDot(value: string, dotIndex: number): boolean {
  if (dotIndex === 0 || value.charAt(dotIndex) !== "." || value.charAt(dotIndex + 1) !== " ") {
    return false;
  }
  for (let index = 0; index < dotIndex; index += 1) {
    const char = value.charAt(index);
    if (char < "0" || char > "9") {
      return false;
    }
  }
  return true;
}

/** Escape Markdown metacharacters for plain text contexts such as headings. */
function escapeMarkdownText(value: string): string {
  let escaped = "";
  for (const char of normalizeMarkdownText(value)) {
    escaped += MARKDOWN_TEXT_ESCAPES.has(char) ? `\\${char}` : char;
  }
  return neutralizeMentions(escaped);
}

/** Escape untrusted paragraph text without over-escaping normal punctuation. */
function escapeMarkdownParagraph(value: string): string {
  const normalized = normalizeMarkdownText(value);
  let escaped = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized.charAt(index);
    const shouldEscape =
      MARKDOWN_PARAGRAPH_ESCAPES.has(char) ||
      (index === 0 && char === "-") ||
      isOrderedListDot(normalized, index);
    escaped += shouldEscape ? `\\${char}` : char;
  }
  return neutralizeMentions(escaped);
}

/** Wrap suggested code in a ```suggestion fence longer than any backtick run in it. */
function suggestionBlock(code: string): string {
  const longestRun = Math.max(0, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}suggestion\n${code.replace(/\n$/, "")}\n${fence}`;
}

/** Return true when a finding includes a non-empty committable suggestion. */
function hasSuggestion(finding: Finding): boolean {
  return Boolean(finding.suggestion?.trim());
}

/** Return true when a suggestion would replace more than one line. */
function hasMultiLineSuggestion(finding: Finding): boolean {
  const suggestion = finding.suggestion?.replaceAll("\r\n", "\n").replace(/\n+$/, "") ?? "";
  return suggestion.includes("\n");
}

/** Format one finding as an inline comment body (severity badge + optional fix). */
export function formatFindingComment(finding: Finding): string {
  const parts = [
    `${SEVERITY_BADGE[finding.severity]} **[${finding.severity}] ${escapeMarkdownText(finding.title)}**`,
    "",
    escapeMarkdownParagraph(finding.body)
  ];
  if (hasSuggestion(finding)) {
    parts.push("", suggestionBlock(finding.suggestion ?? ""));
  }
  return parts.join("\n");
}

/** Format the most specific location available for a finding. */
function findingLocation(finding: Finding): string {
  if (finding.line === undefined) {
    return finding.file;
  }
  if (finding.endLine !== undefined && finding.endLine > finding.line) {
    return `${finding.file}:${finding.line}-${finding.endLine}`;
  }
  return `${finding.file}:${finding.line}`;
}

/** Format a finding that could not be emitted as an inline GitHub comment. */
function formatUnmappedFinding(finding: Finding): string {
  return [`### ${escapeMarkdownText(findingLocation(finding))}`, "", formatFindingComment(finding)].join("\n");
}

/** Build the fallback review-body section for findings outside changed diff lines. */
function formatUnmappedFindings(findings: Finding[]): string {
  if (findings.length === 0) {
    return "";
  }

  const entries = findings.map(formatUnmappedFinding).join("\n\n");
  return [
    "## Unmapped findings",
    "",
    "These findings could not be anchored to changed diff lines, so they are included here instead.",
    "",
    entries
  ].join("\n");
}

/** Append unmapped findings to the review body without changing inline comments. */
function withUnmappedFindings(summaryBody: string, unmapped: Finding[]): string {
  const section = formatUnmappedFindings(unmapped);
  return [summaryBody.trimEnd(), section].filter(Boolean).join("\n\n");
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

    const endLine = finding.endLine;
    const hasRange = endLine !== undefined && endLine > finding.line;
    const canAnchorRange = hasRange ? sameHunkRange(fileLines, finding.line, endLine) : false;

    if (hasSuggestion(finding) && !canAnchorRange && (hasRange || hasMultiLineSuggestion(finding))) {
      unmapped.push(finding);
      continue;
    }

    const comment: ReviewComment = {
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: formatFindingComment(finding),
      fingerprint: findingFingerprint(finding)
    };

    if (canAnchorRange && endLine !== undefined) {
      comment.start_line = finding.line;
      comment.start_side = "RIGHT";
      comment.line = endLine;
    }

    comments.push(comment);
  }

  return { comments, unmapped };
}

/**
 * Assemble the single published review: the walkthrough `summaryBody` plus
 * inline comments for the findings that anchor to the diff. Unmapped findings
 * are appended to the body with full detail so non-inline findings are not lost.
 */
export function buildReviewPayload(input: {
  findings: Finding[];
  diff: ParsedDiff;
  summaryBody: string;
  event?: ReviewEvent;
}): ReviewPayload {
  const { comments, unmapped } = buildInlineComments(input.findings, input.diff);
  return {
    body: withUnmappedFindings(input.summaryBody, unmapped),
    event: input.event ?? "COMMENT",
    comments
  };
}
